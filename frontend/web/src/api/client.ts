type JsonMethod = "DELETE" | "GET" | "POST" | "PUT";

type JsonRequest = {
  method?: JsonMethod;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
};

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const value = payload as { error?: unknown; detail?: unknown };
    if (typeof value.error === "string") return value.error;
    if (value.error && typeof value.error === "object") {
      const message = (value.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof value.detail === "string") return value.detail;
  }
  return `请求失败（HTTP ${status}）`;
}

export async function requestJson<T>(url: string, request: JsonRequest = {}): Promise<T> {
  const response = await fetch(url, {
    method: request.method || "GET",
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
    headers: {
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
    },
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  if (!isJson) throw new Error("服务暂时不可用，请稍后再试");
  if (payload && typeof payload === "object") {
    const value = payload as { success?: unknown; error?: unknown; data?: unknown };
    if (value.success === false) throw new Error(errorMessage(payload, response.status));
    if ("data" in value) return value.data as T;
  }
  return payload as T;
}
