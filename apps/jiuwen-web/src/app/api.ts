export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:3001";

export async function fetchFromApi<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}
