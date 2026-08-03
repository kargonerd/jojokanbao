import { getStore } from "@edgeone/pages-blob";
import {
  PersistentCredentialStore,
  parseCredentialFile,
  type AgentEnvironment,
  type CredentialFile,
  type CredentialPersistence,
} from "@jojo/agent-runtime";

const BLOB_NAMESPACE = "jojo-agent-secrets";
const BLOB_KEY = "credentials.v1.aes-gcm.json";

interface BlobStore {
  get(
    key: string,
    options?: { type?: "text"; consistency?: "strong" },
  ): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { onlyIfNew?: boolean },
  ): Promise<void>;
}

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function encryptionKey(value: string | undefined): Uint8Array {
  if (!value?.trim()) {
    throw new Error(
      "JOJO_AGENT_CREDENTIAL_KEY is required for deployed Codex OAuth",
    );
  }
  const bytes = fromBase64(value.trim());
  if (bytes.byteLength !== 32) {
    throw new Error("JOJO_AGENT_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
  }
  return bytes;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptCredentials(
  credentials: CredentialFile,
  rawKey: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(rawKey),
    plaintext,
  );
  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

async function decryptCredentials(
  value: string,
  rawKey: Uint8Array,
): Promise<CredentialFile> {
  const envelope = JSON.parse(value) as Partial<EncryptedEnvelope>;
  if (
    envelope.version !== 1
    || typeof envelope.iv !== "string"
    || typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Stored Agent credential envelope is invalid");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(envelope.iv)) },
    await aesKey(rawKey),
    asArrayBuffer(fromBase64(envelope.ciphertext)),
  );
  return parseCredentialFile(new TextDecoder().decode(plaintext));
}

export class EdgeOneEncryptedCredentialPersistence implements CredentialPersistence {
  private seeded = false;

  constructor(
    private readonly store: BlobStore,
    private readonly rawKey: Uint8Array,
    private readonly seed?: string,
  ) {}

  async read(): Promise<unknown | undefined> {
    const stored = await this.store.get(BLOB_KEY, {
      type: "text",
      consistency: "strong",
    });
    if (typeof stored === "string" && stored) {
      return decryptCredentials(stored, this.rawKey);
    }
    if (!this.seed || this.seeded) return undefined;

    const credentials = parseCredentialFile(this.seed);
    try {
      await this.store.set(
        BLOB_KEY,
        await encryptCredentials(credentials, this.rawKey),
        { onlyIfNew: true },
      );
    } catch (error) {
      const concurrentlySeeded = await this.store.get(BLOB_KEY, {
        type: "text",
        consistency: "strong",
      });
      if (typeof concurrentlySeeded === "string" && concurrentlySeeded) {
        this.seeded = true;
        return decryptCredentials(concurrentlySeeded, this.rawKey);
      }
      throw error;
    }
    this.seeded = true;
    return credentials;
  }

  async write(credentials: CredentialFile): Promise<void> {
    await this.store.set(BLOB_KEY, await encryptCredentials(credentials, this.rawKey));
    this.seeded = true;
  }
}

export function createEdgeOneCredentialStore(
  environment: AgentEnvironment,
  store: BlobStore = getStore(BLOB_NAMESPACE) as BlobStore,
) {
  const persistence = new EdgeOneEncryptedCredentialPersistence(
    store,
    encryptionKey(environment.JOJO_AGENT_CREDENTIAL_KEY),
    environment.CODEX_AUTH_JSON,
  );
  return new PersistentCredentialStore(persistence);
}
