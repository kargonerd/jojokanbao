import {
  PersistentCredentialStore,
  parseCredentialFile,
  type CredentialFile,
  type CredentialPersistence,
} from "../credentials";
import type { AgentEnvironment } from "../models";
import type { EdgeOneConversationStore } from "./types";

const CREDENTIAL_CONVERSATION_ID = "jojo-platform-credentials-v1";

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
      "JOJO_CREDENTIAL_ENCRYPTION_KEY is required for deployed credentials",
    );
  }
  const bytes = fromBase64(value.trim());
  if (bytes.byteLength !== 32) {
    throw new Error(
      "JOJO_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
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
    throw new Error("Stored platform credential envelope is invalid");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(envelope.iv)) },
    await aesKey(rawKey),
    asArrayBuffer(fromBase64(envelope.ciphertext)),
  );
  return parseCredentialFile(new TextDecoder().decode(plaintext));
}

export class EdgeOneEncryptedCredentialPersistence implements CredentialPersistence {
  private messageId: string | undefined;

  constructor(
    private readonly store: EdgeOneConversationStore,
    private readonly rawKey: Uint8Array,
  ) {}

  async read(): Promise<unknown | undefined> {
    const messages = await this.store.getMessages({
      conversationId: CREDENTIAL_CONVERSATION_ID,
      limit: 1,
      order: "desc",
    });
    const stored = messages[0]?.content;
    this.messageId = messages[0]?.messageId;
    if (typeof stored === "string" && stored) {
      return decryptCredentials(stored, this.rawKey);
    }
    return undefined;
  }

  async write(credentials: CredentialFile): Promise<void> {
    const content = await encryptCredentials(credentials, this.rawKey);
    if (!this.messageId) {
      const messages = await this.store.getMessages({
        conversationId: CREDENTIAL_CONVERSATION_ID,
        limit: 1,
        order: "desc",
      });
      this.messageId = messages[0]?.messageId;
    }
    const metadata = {
      kind: "encrypted-platform-credentials",
      version: 1,
    };
    if (this.messageId && this.store.updateMessage) {
      await this.store.updateMessage({
        conversationId: CREDENTIAL_CONVERSATION_ID,
        messageId: this.messageId,
        content,
        metadata,
      });
      return;
    }
    this.messageId = await this.store.appendMessage({
      conversationId: CREDENTIAL_CONVERSATION_ID,
      role: "system",
      content,
      metadata,
    });
  }
}

export function createEdgeOneCredentialStore(
  environment: AgentEnvironment,
  store: EdgeOneConversationStore | undefined,
) {
  if (!store) {
    throw new Error("问答凭证存储暂时不可用");
  }
  const persistence = new EdgeOneEncryptedCredentialPersistence(
    store,
    encryptionKey(environment.JOJO_CREDENTIAL_ENCRYPTION_KEY),
  );
  return new PersistentCredentialStore(persistence);
}
