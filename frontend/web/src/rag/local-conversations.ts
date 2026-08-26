import { authClient } from "../account/auth";
import type {
  RagConversationDetail,
  RagConversationSummary,
} from "./types";

const DATABASE_NAME = "jojo-client-chat";
const DATABASE_VERSION = 1;
const CONVERSATION_STORE = "conversations";
const OWNER_INDEX = "ownerId";

interface StoredConversation extends RagConversationDetail {
  key: string;
  ownerId: string;
  schemaVersion: 1;
}

let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法读取本地会话"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("无法保存本地会话"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地会话保存已中断"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(CONVERSATION_STORE)) return;
      const store = database.createObjectStore(CONVERSATION_STORE, { keyPath: "key" });
      store.createIndex(OWNER_INDEX, "ownerId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("无法打开本地会话存储"));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("本地会话存储正在被其他页面占用，请刷新后重试"));
    };
  });
  return databasePromise;
}

async function currentOwnerId(): Promise<string> {
  const { data, error } = await authClient.auth.getSession();
  if (error) throw error;
  const ownerId = data.session?.user.id;
  if (!ownerId) throw new Error("请先登录后查看历史记录");
  return ownerId;
}

function conversationKey(ownerId: string, conversationId: string): string {
  return `${ownerId}:${conversationId}`;
}

export const localConversationApi = {
  list: async (): Promise<RagConversationSummary[]> => {
    const ownerId = await currentOwnerId();
    const database = await openDatabase();
    const transaction = database.transaction(CONVERSATION_STORE, "readonly");
    const records = await requestResult(
      transaction.objectStore(CONVERSATION_STORE).index(OWNER_INDEX).getAll(ownerId),
    ) as StoredConversation[];
    await transactionDone(transaction);
    return records
      .map((record) => record.conversation)
      .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
  },

  get: async (conversationId: string): Promise<RagConversationDetail> => {
    const ownerId = await currentOwnerId();
    const database = await openDatabase();
    const transaction = database.transaction(CONVERSATION_STORE, "readonly");
    const record = await requestResult(
      transaction.objectStore(CONVERSATION_STORE).get(conversationKey(ownerId, conversationId)),
    ) as StoredConversation | undefined;
    await transactionDone(transaction);
    if (!record) throw new Error("本地没有这条历史记录");
    return {
      conversation: record.conversation,
      messages: record.messages,
    };
  },

  put: async (detail: RagConversationDetail): Promise<void> => {
    const ownerId = await currentOwnerId();
    const database = await openDatabase();
    const transaction = database.transaction(CONVERSATION_STORE, "readwrite");
    transaction.objectStore(CONVERSATION_STORE).put({
      key: conversationKey(ownerId, detail.conversation.id),
      ownerId,
      schemaVersion: 1,
      conversation: detail.conversation,
      messages: detail.messages,
    } satisfies StoredConversation);
    await transactionDone(transaction);
  },

  delete: async (conversationId: string): Promise<void> => {
    const ownerId = await currentOwnerId();
    const database = await openDatabase();
    const transaction = database.transaction(CONVERSATION_STORE, "readwrite");
    transaction.objectStore(CONVERSATION_STORE).delete(conversationKey(ownerId, conversationId));
    await transactionDone(transaction);
  },
};
