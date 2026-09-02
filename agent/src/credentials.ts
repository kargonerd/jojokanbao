import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export type CredentialFile = Record<string, Credential>;

export interface CredentialModifyErrorContext {
  providerId: string;
  current: Credential | undefined;
  error: unknown;
  signal?: AbortSignal;
}

export interface CredentialModifyRecovery {
  credential: Credential | undefined;
}

export interface CredentialPersistence {
  read(): Promise<unknown | undefined>;
  write(credentials: CredentialFile): Promise<void>;
  /**
   * Recover a write callback that lost a race in another isolate/process.
   * Returning undefined preserves the original error.
   */
  recoverModifyError?(
    context: CredentialModifyErrorContext,
  ): Promise<CredentialModifyRecovery | undefined>;
}

export interface PersistentCredentialStoreOptions {
  /** Serializes all store instances that share this persistence namespace. */
  coordinationKey?: string;
}

const sharedQueues = new Map<string, Promise<void>>();

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

/** Legacy credentials have generation zero; only admin claims advance it. */
export function credentialGeneration(
  credential: Credential | undefined,
): number {
  if (credential?.type !== "oauth") return 0;
  const generation = credential.generation;
  return typeof generation === "number"
    && Number.isSafeInteger(generation)
    && generation >= 0
    ? generation
    : 0;
}

export function credentialFileGeneration(credentials: CredentialFile): number {
  return Object.values(credentials).reduce(
    (highest, credential) => Math.max(highest, credentialGeneration(credential)),
    0,
  );
}

/**
 * Pi CredentialStore backed by an application-owned persistence adapter.
 *
 * Writes are serialized across store instances inside this process when they
 * share a coordination key. Cross-isolate persistence can additionally recover
 * a known optimistic race through `recoverModifyError`.
 */
export class PersistentCredentialStore implements CredentialStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: CredentialPersistence,
    private readonly options: PersistentCredentialStoreOptions = {},
  ) {}

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.readAll())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const credentials = await this.readAll();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const credentials = await this.readAll();
      const current = credentials[providerId];
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch (error) {
        const recovered = await this.persistence.recoverModifyError?.({
          providerId,
          current,
          error,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (recovered) return recovered.credential;
        throw error;
      }
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.persistence.write(credentials);
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.enqueue(async () => {
      options?.signal?.throwIfAborted();
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
    // Persistence adapters read and replace the entire credential file, so the
    // coordination key must serialize the whole namespace, not just one
    // provider, or two provider writes could overwrite each other.
    const sharedKey = this.options.coordinationKey;
    const previous = sharedKey
      ? sharedQueues.get(sharedKey) ?? Promise.resolve()
      : this.queue;
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(() => undefined, () => undefined);
    if (sharedKey) {
      sharedQueues.set(sharedKey, tail);
      void tail.then(() => {
        if (sharedQueues.get(sharedKey) === tail) sharedQueues.delete(sharedKey);
      });
    } else {
      this.queue = tail;
    }
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
    super(persistence, { coordinationKey: `file:${path}` });
    this.path = path;
  }
}
