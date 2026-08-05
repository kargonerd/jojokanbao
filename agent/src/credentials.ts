import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export type CredentialFile = Record<string, Credential>;

export interface CredentialPersistence {
  read(): Promise<unknown | undefined>;
  write(credentials: CredentialFile): Promise<void>;
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "api_key") {
    return "key" in value && typeof value.key === "string" && value.key.length > 0;
  }
  return value.type === "oauth"
    && "access" in value
    && typeof value.access === "string"
    && "refresh" in value
    && typeof value.refresh === "string"
    && "expires" in value
    && typeof value.expires === "number";
}

export function parseCredentialFile(value: unknown): CredentialFile {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pi credential data must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, Credential] => isCredential(entry[1]),
    ),
  );
}

/**
 * Pi CredentialStore backed by an application-owned persistence adapter.
 *
 * All writes are serialized inside this process. Deployments that can receive
 * concurrent writes should also provide atomic/strongly-consistent persistence.
 */
export class PersistentCredentialStore implements CredentialStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: CredentialPersistence) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.readAll();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const credentials = await this.readAll();
      const current = credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.persistence.write(credentials);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(async () => {
      const credentials = await this.readAll();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.persistence.write(credentials);
    });
  }

  private async readAll(): Promise<CredentialFile> {
    const value = await this.persistence.read();
    return value === undefined ? {} : parseCredentialFile(value);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => undefined).then(task);
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }
}

/**
 * Local/server credential storage compatible with `pi-ai login`.
 * The file must stay outside source control and should live on a persistent disk.
 */
export class JsonCredentialStore extends PersistentCredentialStore {
  readonly path: string;

  constructor(path: string) {
    const persistence: CredentialPersistence = {
      read: async () => {
        try {
          return JSON.parse(await readFile(path, "utf8")) as unknown;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      write: async (credentials) => {
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temporaryPath,
          `${JSON.stringify(credentials, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, path);
      },
    };
    super(persistence);
    this.path = path;
  }
}
