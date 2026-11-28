/** 24 位十六进制随机 id。crypto.randomUUID 要 Chrome 92，老内核回退到 getRandomValues（Chrome 11）。 */
export function randomId(length = 24): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}
