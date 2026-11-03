import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AudioCaptureService } from "./audio-capture-service";
import { AudioChunkStore } from "./audio-chunk-store";
import { TranscriptionService } from "./transcription-service";

const DEFAULT_DEVICE =
  "alsa_output.usb-Logitech_USB_Headset_Logitech_USB_Headset-00.analog-stereo.monitor";
// Mantém várias requisições em andamento para que uma resposta lenta do provedor
// não bloqueie todos os blocos seguintes. O provedor ainda pode aplicar limites.
const MAX_CONCURRENT_TRANSLATIONS = 4;

function getChunkSeconds(): number {
  const value = Number(process.env.AUDIO_CHUNK_SECONDS ?? "30");
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error("AUDIO_CHUNK_SECONDS deve ser um inteiro entre 1 e 30.");
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Defina OPENROUTER_API_KEY no ambiente ou no arquivo .env antes de iniciar.",
    );
  }

  const model =
    process.env.OPENROUTER_MODEL?.trim() ||
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
  const audio = new AudioCaptureService({
    device: process.env.AUDIO_DEVICE?.trim() || DEFAULT_DEVICE,
    chunkSeconds: getChunkSeconds(),
  });
  const queueDirectory = path.resolve(
    process.cwd(),
    process.env.AUDIO_QUEUE_DIR?.trim() || "data/audio-queue",
  );
  const transcriptFile = path.resolve(
    process.cwd(),
    process.env.AUDIO_TRANSCRIPT_FILE?.trim() || "data/transcript.txt",
  );
  const chunkStore = new AudioChunkStore(queueDirectory, transcriptFile);
  const pendingChunks = await chunkStore.initialize();
  const translator = new TranscriptionService(apiKey, model);
  const translationQueue: Array<{
    id: number;
    filePath: string;
    capturedAt: number;
  }> = [];
  let nextJobId = 0;
  let activeTranslations = 0;
  const idleWaiters: Array<() => void> = [];
  let shuttingDown = false;
  let lastSilenceWarningAt = 0;
  let signalDetected = false;
  let freeModelDailyLimitReached = false;
  let storageFailureReported = false;
  let persistChain = Promise.resolve();

  const resolveIdleWaiters = (): void => {
    if (translationQueue.length === 0 && activeTranslations === 0) {
      idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  };

  const processNext = (): void => {
    while (
      !freeModelDailyLimitReached &&
      activeTranslations < MAX_CONCURRENT_TRANSLATIONS &&
      translationQueue.length > 0
    ) {
      const job = translationQueue.shift()!;

      activeTranslations += 1;
      void Promise.resolve()
        .then(async () =>
          translator.translateToEnglish(await readFile(job.filePath)),
        )
        .then(async (translation) => {
          const capturedTime = new Date(job.capturedAt).toLocaleTimeString();
          const delaySeconds = ((Date.now() - job.capturedAt) / 1000).toFixed(1);
          if (!translation) {
            process.stderr.write(
              `[bloco ${job.id + 1}, capturado ${capturedTime}] O modelo não retornou texto; o áudio foi mantido na fila para tentar novamente depois.\n`,
            );
            return;
          }

          await chunkStore.complete(job.filePath, translation);
          await new Promise<void>((resolve, reject) => {
            process.stdout.write(
              `[bloco ${job.id + 1}, capturado ${capturedTime}, atraso ${delaySeconds}s] ${translation}\n`,
              (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              },
            );
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (/429/.test(message) && /free-models-per-day/i.test(message)) {
            if (!freeModelDailyLimitReached) {
              freeModelDailyLimitReached = true;
              translationQueue.length = 0;
              process.stderr.write(
                `Limite diário de requisições gratuitas do OpenRouter atingido. Parei novas chamadas; os blocos pendentes estão salvos em ${queueDirectory} e serão tentados na próxima execução. Confira os limites em https://openrouter.ai/settings/credits.\n`,
              );
            }
            return;
          }
          if (
            /402/.test(message) &&
            /balance.*audio|audio.*balance/i.test(message)
          ) {
            process.stderr.write(
              "O OpenRouter exige saldo mínimo de US$ 0,50 para processar áudio, mesmo usando um modelo :free. Adicione esse saldo na conta OpenRouter ou use uma solução de transcrição local.\n",
            );
          }
          process.stderr.write(
            `[bloco ${job.id + 1}] Falha ao processar o bloco: ${message}. Se ainda estiver pendente, o áudio fica em ${job.filePath}; o texto consolidado fica em ${transcriptFile}.\n`,
          );
        })
        .finally(() => {
          activeTranslations -= 1;
          processNext();
          resolveIdleWaiters();
        });
    }

    resolveIdleWaiters();
  };

  const enqueueTranslation = (pcm: Buffer, capturedAt: number): void => {
    // Descarta blocos quase silenciosos para não gastar chamadas da API com
    // silêncio digital; esta medição é do sinal capturado, não do volume físico.
    let sumOfSquares = 0;
    let sampleCount = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset);
      sumOfSquares += sample * sample;
      sampleCount += 1;
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumOfSquares / sampleCount) : 0;

    if (rms < 60) {
      const now = Date.now();
      if (now - lastSilenceWarningAt >= 30_000) {
        process.stderr.write(
          "O monitor digital de saída está em silêncio; blocos sem sinal audível são ignorados.\n",
        );
        lastSilenceWarningAt = now;
      }
      return;
    }
    if (!signalDetected) {
      process.stderr.write("Sinal de áudio detectado no monitor.\n");
      signalDetected = true;
    }

    persistChain = persistChain
      .then(async () => {
        const filePath = await chunkStore.save(pcm, capturedAt);
        const job = { id: nextJobId, filePath, capturedAt };
        nextJobId += 1;

        // Salvar no disco vem antes de adicionar à fila em memória ou enviar
        // para a API, para que falhas/limites não descartem o áudio capturado.
        if (!freeModelDailyLimitReached) {
          translationQueue.push(job);
          processNext();
        }
      })
      .catch((error: unknown) => {
        if (!storageFailureReported) {
          storageFailureReported = true;
          const message =
            error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `Falha ao persistir o bloco de áudio; encerrando a captura para evitar perdas: ${message}\n`,
          );
          void shutdown(1);
        }
      });
  };

  const waitForTranslations = async (): Promise<void> => {
    await persistChain;
    if (translationQueue.length === 0 && activeTranslations === 0) {
      return;
    }
    await new Promise<void>((resolve) => idleWaiters.push(resolve));
  };

  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write("\nEncerrando captura e aguardando o processamento...\n");
    await audio.stop();
    await persistChain;
    await waitForTranslations();
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  for (const chunk of pendingChunks) {
    translationQueue.push({
      id: nextJobId,
      filePath: chunk.path,
      capturedAt: chunk.capturedAt,
    });
    nextJobId += 1;
  }
  if (pendingChunks.length > 0) {
    process.stderr.write(
      `Recuperados ${pendingChunks.length} bloco(s) pendente(s) da fila em ${queueDirectory}.\n`,
    );
    processNext();
  }

  // Lê o monitor digital da saída configurada. Ele inclui o áudio encaminhado
  // ao sink (possivelmente o Netflix), não captura uma aba específica nem usa mic.
  await audio.start(enqueueTranslation, (error) => {
    process.stderr.write(`${error.message}\n`);
    void shutdown(1);
  });

  process.stdout.write(
    `Capturando ${process.env.AUDIO_DEVICE?.trim() || DEFAULT_DEVICE} em blocos de ${getChunkSeconds()}s. Modelo OpenRouter: ${model}. Tradução para inglês ativa; transcrição salva em ${transcriptFile}. Ctrl+C encerra.\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
