import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { cleanTranscript } from "./transcript-text";

export interface StoredAudioChunk {
  capturedAt: number;
  path: string;
}

export class AudioChunkStore {
  private completionChain = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly transcriptFile: string,
  ) {}

  async initialize(): Promise<StoredAudioChunk[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.transcriptPath), {
      recursive: true,
      mode: 0o700,
    });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const names = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    const pending: StoredAudioChunk[] = [];
    const completed = new Map<string, StoredAudioChunk>();

    for (const name of names) {
      const match = /^(chunk-(\d{13})-[0-9a-f-]+)\.(pcm|txt)$/.exec(name);
      if (!match) {
        continue;
      }

      const chunk = {
        capturedAt: Number(match[2]),
        path: path.join(this.directory, `${match[1]}.pcm`),
      };
      if (match[3] === "txt") {
        completed.set(match[1], chunk);
      } else if (names.has(`${match[1]}.txt`)) {
        completed.set(match[1], chunk);
      } else {
        pending.push(chunk);
      }
    }

    await this.rebuildTranscript([...completed.values()]);

    // If shutdown happened after writing the translation sidecar but before
    // deleting the source audio, rebuilding the transcript makes deletion safe.
    for (const chunk of completed.values()) {
      const translationPath = path.join(
        this.directory,
        `${path.basename(chunk.path, ".pcm")}.txt`,
      );
      const translation = cleanTranscript(
        await readFile(translationPath, "utf8"),
      );
      await this.writeAtomically(
        translationPath,
        translation ? `${translation}\n` : "",
      );
      await unlink(chunk.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    await this.rebuildTranscript([...completed.values()]);

    return pending.sort((left, right) => left.path.localeCompare(right.path));
  }

  async save(pcm: Buffer, capturedAt: number): Promise<string> {
    const fileName = `chunk-${String(capturedAt).padStart(13, "0")}-${randomUUID()}.pcm`;
    const finalPath = path.join(this.directory, fileName);
    const temporaryPath = path.join(
      this.directory,
      `.${fileName}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, pcm, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, finalPath);
      return finalPath;
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") {
          throw cleanupError;
        }
      });
      throw error;
    }
  }

  async complete(filePath: string, translation: string): Promise<void> {
    const operation = this.completionChain.then(() =>
      this.completeChunk(filePath, translation),
    );
    this.completionChain = operation.catch(() => undefined);
    return operation;
  }

  private async completeChunk(
    filePath: string,
    translation: string,
  ): Promise<void> {
    this.assertQueuePath(filePath);
    const chunkName = path.basename(filePath, ".pcm");
    const match = /^chunk-(\d{13})-[0-9a-f-]+$/.exec(chunkName);
    if (!match) {
      throw new Error("Nome de bloco de áudio inválido.");
    }

    const translationPath = path.join(this.directory, `${chunkName}.txt`);
    await this.writeAtomically(
      translationPath,
      `${cleanTranscript(translation)}\n`,
    );

    const entries = await readdir(this.directory, { withFileTypes: true });
    const completed = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^chunk-\d{13}-[0-9a-f-]+\.txt$/.test(entry.name),
      )
      .map((entry) => {
        const timestamp = /^chunk-(\d{13})-/.exec(entry.name)?.[1];
        if (!timestamp) {
          throw new Error(`Nome de transcrição inválido: ${entry.name}`);
        }
        return {
          capturedAt: Number(timestamp),
          path: path.join(this.directory, entry.name.replace(/\.txt$/, ".pcm")),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    await this.rebuildTranscript(completed);
    await unlink(filePath);
  }

  get transcriptPath(): string {
    return this.transcriptFile;
  }

  private async rebuildTranscript(
    chunks: StoredAudioChunk[],
  ): Promise<void> {
    const lines: string[] = [];
    for (const chunk of chunks) {
      const chunkName = path.basename(chunk.path, ".pcm");
      const translationPath = path.join(
        this.directory,
        `${chunkName}.txt`,
      );
      const translation = await readFile(translationPath, "utf8");
      const cleaned = cleanTranscript(translation);
      if (cleaned) {
        lines.push(cleaned);
      }
    }
    await this.writeAtomically(this.transcriptPath, lines.join("\n"));
  }

  private async writeAtomically(filePath: string, content: string): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") {
          throw cleanupError;
        }
      });
      throw error;
    }
  }

  private assertQueuePath(filePath: string): void {
    if (path.dirname(filePath) !== this.directory) {
      throw new Error("Recusa de acessar arquivo fora da fila de áudio.");
    }
  }
}
