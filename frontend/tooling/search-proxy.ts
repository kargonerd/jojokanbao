export function createSearchProxy(target = "https://s1.jojokanbao.cn") {
  return {
    "^/search-api(?:/|\\?|$)": {
      target,
      changeOrigin: true,
      secure: true,
      rewrite: (path: string) => path.replace(/^\/search-api(?=\/|\?|$)/, ""),
    },
  };
}
