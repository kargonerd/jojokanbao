/** Bundled publisher artwork shared by Web, Desktop and native apps. */
export const TIMES_SOURCE_LOGOS = {
  "agencia-brasil": "agencia-brasil.png",
  africanews: "africanews.png",
  aljazeera: "aljazeera.png",
  ap: "ap.png",
  axios: "axios.png",
  bloomberg: "bloomberg.png",
  chinanews: "chinanews.jpg",
  cls: "cls.png",
  cna: "cna.png",
  dw: "dw.png",
  "focus-taiwan": "focus-taiwan.jpg",
  ft: "ft.png",
  guardian: "guardian.png",
  nikkei: "nikkei.png",
  npr: "npr.png",
  nyt: "nyt.png",
  people: "people.jpg",
  reuters: "reuters.png",
  scmp: "scmp.png",
  thepaper: "thepaper.png",
  xinhua: "xinhua.jpg",
  zaobao: "zaobao.png",
} as const;

export function timesSourceLogoPath(id: string, base = "/"): string | undefined {
  const filename = TIMES_SOURCE_LOGOS[id as keyof typeof TIMES_SOURCE_LOGOS];
  return filename ? `${base}times/source-logos/${filename}` : undefined;
}
