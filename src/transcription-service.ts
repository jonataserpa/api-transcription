import OpenAI from "openai";
import { cleanTranscript } from "./transcript-text";

type OpenRouterChatRequest = Parameters<
  OpenAI["chat"]["completions"]["create"]
>[0] & {
  // O OpenRouter aceita este limite de raciocínio; o tipo público do SDK
  // compatível com OpenAI não declara esse campo específico do OpenRouter.
  reasoning: { max_tokens: number };
  stream: false;
};

export class TranscriptionService {
  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "http://localhost",
        "X-Title": "api-transcription",
      },
    });
    this.model = model;
  }

  private readonly model: string;

  async translateToEnglish(pcm: Buffer): Promise<string> {
    // O provedor recebe um WAV padrão, não PCM sem cabeçalho. O cabeçalho
    // descreve o formato de amostras produzido por AudioCaptureService.
    const wav = this.wrapPcmAsWav(pcm);
    const request: OpenRouterChatRequest = {
      model: this.model,
      temperature: 0,
      max_tokens: 2048,
      reasoning: { max_tokens: 128 },
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Return only the verbatim spoken words in English. Do not include headings, timestamps, speaker labels, quotation marks, commentary, analysis, or descriptions. Preserve the wording; add only normal punctuation. If there is no intelligible speech, return an empty string.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                // A API recebe o WAV (cabeçalho + PCM) em Base64 dentro do JSON.
                // Isso transporta o áudio; não o converte em texto localmente.
                data: wav.toString("base64"),
                format: "wav",
              },
            },
          ],
        },
      ],
    };
    const result = await this.client.chat.completions.create(request);

    const choice = result.choices[0];
    const translation = choice?.message.content;
    if (typeof translation !== "string") {
      const refusal = choice?.message.refusal;
      const details = [
        `finish_reason=${choice?.finish_reason ?? "indisponível"}`,
        result.usage
          ? `completion_tokens=${result.usage.completion_tokens}`
          : undefined,
        result.usage?.completion_tokens_details?.reasoning_tokens !== undefined
          ? `reasoning_tokens=${result.usage.completion_tokens_details.reasoning_tokens}`
          : undefined,
        refusal ? `refusal=${refusal}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `OpenRouter retornou uma resposta sem texto (${details}). Confira se o modelo configurado aceita entrada de áudio e se o bloco contém fala audível.`,
      );
    }
    return cleanTranscript(translation);
  }

  private wrapPcmAsWav(pcm: Buffer): Buffer {
    // WAV usa 44 bytes de cabeçalho RIFF seguidos pelos bytes de áudio. Estes
    // parâmetros precisam corresponder ao --rate, --channels e --format do parec.
    const header = Buffer.alloc(44);
    const sampleRate = 16_000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    // Bloco RIFF: tamanho total do arquivo menos "RIFF" e este campo de tamanho.
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    // Sub-bloco fmt: codificação PCM (1), mono, 16 kHz, amostras signed 16-bit.
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    // Sub-bloco data: tamanho, em bytes, das amostras PCM capturadas.
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);

    // Junta metadados e amostras. Nenhum reconhecimento ou tradução ocorre aqui:
    // apenas encapsulamos o PCM em um formato aceito pelo modelo de áudio remoto.
    return Buffer.concat([header, pcm]);
  }
}
