import type { TIMES_SOURCE_LOGOS } from "@jojo/content";

// Metro requires static require() paths; the shared registry enforces full coverage.
export const SOURCE_LOGOS: Record<keyof typeof TIMES_SOURCE_LOGOS, number> & Partial<Record<string, number>> = {
  "agencia-brasil": require("../../../web/public/times/source-logos/agencia-brasil.png"),
  africanews: require("../../../web/public/times/source-logos/africanews.png"),
  aljazeera: require("../../../web/public/times/source-logos/aljazeera.png"),
  ap: require("../../../web/public/times/source-logos/ap.png"),
  axios: require("../../../web/public/times/source-logos/axios.png"),
  bloomberg: require("../../../web/public/times/source-logos/bloomberg.png"),
  chinanews: require("../../../web/public/times/source-logos/chinanews.jpg"),
  cls: require("../../../web/public/times/source-logos/cls.png"),
  cna: require("../../../web/public/times/source-logos/cna.png"),
  dw: require("../../../web/public/times/source-logos/dw.png"),
  "focus-taiwan": require("../../../web/public/times/source-logos/focus-taiwan.jpg"),
  ft: require("../../../web/public/times/source-logos/ft.png"),
  guardian: require("../../../web/public/times/source-logos/guardian.png"),
  nikkei: require("../../../web/public/times/source-logos/nikkei.png"),
  npr: require("../../../web/public/times/source-logos/npr.png"),
  nyt: require("../../../web/public/times/source-logos/nyt.png"),
  people: require("../../../web/public/times/source-logos/people.jpg"),
  reuters: require("../../../web/public/times/source-logos/reuters.png"),
  scmp: require("../../../web/public/times/source-logos/scmp.png"),
  thepaper: require("../../../web/public/times/source-logos/thepaper.png"),
  xinhua: require("../../../web/public/times/source-logos/xinhua.jpg"),
  zaobao: require("../../../web/public/times/source-logos/zaobao.png"),
};
