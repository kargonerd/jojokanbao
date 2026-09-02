import {
  PersistentCredentialStore,
  credentialFileGeneration,
  parseCredentialFile,
  type CredentialFile,
  type CredentialModifyErrorContext,
  type CredentialModifyRecovery,
  type CredentialPersistence,
} from "../credentials";
import {
  openAICodexRefreshErrorCode,
  type AgentEnvironment,
} from "../models";
import type { EdgeOneMessageStore } from "./types";

const CREDENTIAL_CONVERSATION_ID = "jojo-platform-credentials-v1";
const CREDENTIAL_HISTORY_LIMIT = 20;
const OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1_000;
const REFRESH_RACE_RETRY_DELAYS_MS = [0, 25, 75, 150, 300, 600, 1_000];

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
  private loaded = false;
  private highestGeneration = -1;
  private readonly messageIdsByGeneration = new Map<number, string>();

  constructor(
    private readonly store: EdgeOneMessageStore,
    private readonly rawKey: Uint8Array,
  ) {}

  async read(): Promise<unknown | undefined> {
    const messages = await this.store.getMessages({
      conversationId: CREDENTIAL_CONVERSATION_ID,
      limit: CREDENTIAL_HISTORY_LIMIT,
      order: "desc",
    });
    this.loaded = true;
    this.highestGeneration = -1;
    this.messageIdsByGeneration.clear();

    let selected: CredentialFile | undefined;
    for (const message of messages) {
      if (typeof message.content !== "string" || !message.content) continue;
      const credentials = await decryptCredentials(message.content, this.rawKey);
      const generation = credentialFileGeneration(credentials);
      if (message.messageId && !this.messageIdsByGeneration.has(generation)) {
        this.messageIdsByGeneration.set(generation, message.messageId);
      }
      // Messages arrive newest first, so keep the first record for equal
      // generations and only replace it with a strictly newer token family.
      if (generation > this.highestGeneration) {
        this.highestGeneration = generation;
        selected = credentials;
      }
    }
    return selected;
  }

  async write(credentials: CredentialFile): Promise<void> {
    if (!this.loaded) await this.read();
    const generation = credentialFileGeneration(credentials);
    const content = await encryptCredentials(credentials, this.rawKey);
    const metadata = {
      kind: "encrypted-platform-credentials",
      version: 1,
    };
    const messageId = this.messageIdsByGeneration.get(generation);
    if (generation <= this.highestGeneration && messageId && this.store.updateMessage) {
      await this.store.updateMessage({
        conversationId: CREDENTIAL_CONVERSATION_ID,
        messageId,
        content,
        metadata,
      });
      return;
    }
    const appendedMessageId = await this.store.appendMessage({
      conversationId: CREDENTIAL_CONVERSATION_ID,
      role: "system",
      content,
      metadata,
    });
    this.messageIdsByGeneration.set(generation, appendedMessageId);
    if (generation > this.highestGeneration) {
      this.highestGeneration = generation;
    }
  }

  async recoverModifyError(
    context: CredentialModifyErrorContext,
  ): Promise<CredentialModifyRecovery | undefined> {
    if (
      context.providerId !== "openai-codex"
      || context.current?.type !== "oauth"
      || openAICodexRefreshErrorCode(context.error) !== "refresh_token_reused"
    ) {
      return undefined;
    }

    for (const delay of REFRESH_RACE_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      context.signal?.throwIfAborted();
      const stored = await this.read();
      const latest = stored === undefined
        ? undefined
        : parseCredentialFile(stored)[context.providerId];
      if (
        latest?.type === "oauth"
        && latest.refresh !== context.current.refresh
        && latest.expires > Date.now() + OAUTH_MINIMUM_VALIDITY_MS
      ) {
        return { credential: latest };
      }
    }
    return undefined;
  }
}

export function createEdgeOneCredentialStore(
  environment: AgentEnvironment,
  store: EdgeOneMessageStore | undefined,
) {
  if (!store) {
    throw new Error("问答凭证存储暂时不可用");
  }
  const persistence = new EdgeOneEncryptedCredentialPersistence(
    store,
    encryptionKey(environment.JOJO_CREDENTIAL_ENCRYPTION_KEY),
  );
  return new PersistentCredentialStore(persistence, {
    coordinationKey: CREDENTIAL_CONVERSATION_ID,
  });
}
