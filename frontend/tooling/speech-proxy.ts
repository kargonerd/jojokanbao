/** Keep Web development on the same listening service as Desktop and mobile. */
export function createSpeechProxy(apiBase = "https://beta.jojokanbao.cn/api/v1") {
  const target = new URL(apiBase);
  const prefix = target.pathname.replace(/\/$/u, "");
  return {
    "^/api/v1/speech(?:/|\\?|$)": {
      target: target.origin,
      changeOrigin: true,
      secure: true,
      rewrite: (path: string) => path.replace(/^\/api\/v1(?=\/speech(?:\/|\?|$))/u, prefix),
    },
  };
}
