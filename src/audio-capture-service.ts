import { spawn, type ChildProcess } from "node:child_process";

export interface AudioCaptureOptions {
  /** Fonte PulseAudio/PipeWire: use o `.monitor` da saída, não um microfone. */
  device: string;
  /** Duração de cada bloco PCM enviado ao callback onChunk. */
  chunkSeconds: number;
  sampleRate?: number;
  channels?: number;
}

export class AudioCaptureService {
  private child?: ChildProcess;
  private pendingBuffers: Buffer[] = [];
  private pendingBytes = 0;
  private onChunk?: (pcm: Buffer, capturedAt: number) => void;
  private stopping = false;
  private exitPromise?: Promise<void>;

  constructor(private readonly options: AudioCaptureOptions) {}

  async start(
    onChunk: (pcm: Buffer, capturedAt: number) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.child) {
      throw new Error("A captura de áudio já está em execução.");
    }

    this.onChunk = onChunk;
    this.stopping = false;
    const sampleRate = this.options.sampleRate ?? 16_000;
    const channels = this.options.channels ?? 1;
    // O parec converte o sinal do monitor em PCM bruto, com amostras signed
    // 16-bit little-endian. Em 16 kHz, mono, cada segundo ocupa 32.000 bytes.
    const bytesPerSecond = sampleRate * channels * 2;
    const chunkBytes = bytesPerSecond * this.options.chunkSeconds;
    const child = spawn(
      "parec",
      [
        `--device=${this.options.device}`,
        "--format=s16le",
        `--rate=${sampleRate}`,
        `--channels=${channels}`,
        "--raw",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;

    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    const started = new Promise<void>((resolve, reject) => {
      let didStart = false;
      child.once("spawn", () => {
        didStart = true;
        resolve();
      });
      child.on("error", (error) => {
        if (!didStart) {
          reject(
            new Error(
              `Não foi possível iniciar parec: ${error.message}. Instale o pacote que fornece parec (PulseAudio/PipeWire).`,
            ),
          );
        } else {
          onError(new Error(`Falha no processo parec: ${error.message}`));
        }
      });
    });

    child.stdout.on("data", (data: Buffer) => {
      // Um evento stdout pode conter um fragmento ou vários blocos. Acumulamos
      // os bytes até completar exatamente a duração configurada.
      let offset = 0;
      while (offset < data.length) {
        const bytesNeeded = chunkBytes - this.pendingBytes;
        const bytesToCopy = Math.min(bytesNeeded, data.length - offset);
        this.pendingBuffers.push(data.subarray(offset, offset + bytesToCopy));
        this.pendingBytes += bytesToCopy;
        offset += bytesToCopy;

        if (this.pendingBytes === chunkBytes) {
          this.emitPending();
        }
      }
    });
    child.stdout.on("error", (error) => {
      onError(new Error(`Falha ao ler o áudio capturado: ${error.message}`));
    });
    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[parec] ${data.toString().trimEnd()}\n`);
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.flushPending();
      if (!this.stopping) {
        onError(
          new Error(
            `O processo parec encerrou inesperadamente (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"}).`,
          ),
        );
      }
    });

    try {
      await started;
    } catch (error) {
      this.child = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.flushPending();
      return;
    }

    this.stopping = true;
    child.kill("SIGTERM");

    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 3_000);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await this.exitPromise;
    }

    this.flushPending();
    this.child = undefined;
  }

  private emitPending(): void {
    const pcm = Buffer.concat(this.pendingBuffers, this.pendingBytes);
    this.pendingBuffers = [];
    this.pendingBytes = 0;
    // Aqui há somente as amostras PCM, sem cabeçalho WAV. O horário marca o fim
    // da captura do bloco e permite calcular o atraso até a resposta da API.
    this.onChunk?.(pcm, Date.now());
  }

  private flushPending(): void {
    // Ao encerrar, entrega as amostras completas restantes, mesmo que não
    // formem um bloco inteiro; descarta apenas um byte incompleto, se houver.
    const completeSampleBytes = this.pendingBytes - (this.pendingBytes % 2);
    if (completeSampleBytes > 0) {
      const pcm = Buffer.concat(this.pendingBuffers, this.pendingBytes).subarray(
        0,
        completeSampleBytes,
      );
      this.onChunk?.(pcm, Date.now());
    }
    this.pendingBuffers = [];
    this.pendingBytes = 0;
  }
}
