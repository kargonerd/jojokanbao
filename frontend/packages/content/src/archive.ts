export const ARCHIVE_WEB_ORIGIN = "https://reader.jojokanbao.cn";
export const ARCHIVE_CDN_ORIGIN = "https://blacknews.jojokanbao.cn";
export const ARCHIVE_SEARCH_API = "https://s1.jojokanbao.cn/search";
export const CONTENT_SEARCH_API = "https://s1.jojokanbao.cn/content/search";

export const ARCHIVE_PUBLICATION_NAMES = ["rmrb", "ckxx", "hq", "rmhb", "sjzs"] as const;
export type ArchivePublicationName = (typeof ARCHIVE_PUBLICATION_NAMES)[number];

export interface ArchivePublicationSummary {
  id: ArchivePublicationName;
  title: string;
  englishTitle: string;
  years: string;
  kind: "报纸" | "杂志";
  type: "newspaper" | "magazine";
  defaultIssueId: string;
}

export const ARCHIVE_PUBLICATIONS = [
  { id: "rmrb", title: "人民日报", englishTitle: "PEOPLE'S DAILY", years: "1946 — 至今", kind: "报纸", type: "newspaper", defaultIssueId: "19761009" },
  { id: "ckxx", title: "参考消息", englishTitle: "REFERENCE NEWS", years: "1957 — 1998", kind: "报纸", type: "newspaper", defaultIssueId: "19760910" },
  { id: "hq", title: "红旗", englishTitle: "RED FLAG", years: "1958 — 1988", kind: "杂志", type: "magazine", defaultIssueId: "196419" },
  { id: "rmhb", title: "人民画报", englishTitle: "CHINA PICTORIAL", years: "1950 — 1976", kind: "杂志", type: "magazine", defaultIssueId: "197292" },
  { id: "sjzs", title: "世界知识", englishTitle: "WORLD AFFAIRS", years: "1934 — 2025", kind: "杂志", type: "magazine", defaultIssueId: "196513" },
] as const satisfies readonly ArchivePublicationSummary[];

export const ARCHIVE_PUBLICATION_BY_ID = Object.fromEntries(
  ARCHIVE_PUBLICATIONS.map((publication) => [publication.id, publication]),
) as Record<ArchivePublicationName, ArchivePublicationSummary>;

export const RMRB_EDGEONE_BLOCKED_ISSUES = [
  "19580504", "19581123", "19610423", "19660420", "19670805", "19740718",
  "19760120", "19890625", "19890626", "20080618", "20080821", "20081025",
  "20081229", "20090430", "20100716", "20110220", "20110702", "20121118",
  "20121120", "20121225", "20140706", "20150116", "20150521", "20150618",
  "20150904", "20150905", "20151205", "20160107", "20160905", "20170125",
  "20170222", "20170427", "20170817", "20171217", "20190204", "20190703",
  "20200122", "20210302", "20210812", "20221206", "20221208", "20230131",
  "20231001", "20231111", "20241006", "20250620", "20250920", "20251121",
  "20260121", "20260509", "20260521",
] as const;

const rmrbEdgeOneBlockedIssues = new Set<string>(RMRB_EDGEONE_BLOCKED_ISSUES);

export function getFacsimileIssueFilename(publication: string, issueId: string): string {
  return publication === "rmrb" && rmrbEdgeOneBlockedIssues.has(issueId)
    ? `${issueId}-r1.pdf`
    : `${issueId}.pdf`;
}

export function archivePdfUrl(
  publication: ArchivePublicationName,
  issueId: string,
  origin = ARCHIVE_CDN_ORIGIN,
): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/${publication.toUpperCase()}/${issueId.slice(0, 4)}/${getFacsimileIssueFilename(publication, issueId)}`;
}

export function archiveWebIssueUrl(
  publication: ArchivePublicationName,
  issueId: string,
  page?: number,
  origin = ARCHIVE_WEB_ORIGIN,
): string {
  const base = origin.replace(/\/$/, "");
  const hash = page && page > 0 ? `#page-${Math.floor(page)}` : "";
  return `${base}/archive/${publication}/${issueId}${hash}`;
}

export function formatArchiveIssueLabel(issueId: string): string {
  if (/^\d{8}$/.test(issueId)) {
    return `${issueId.slice(0, 4)} 年 ${Number(issueId.slice(4, 6))} 月 ${Number(issueId.slice(6, 8))} 日`;
  }
  if (/^\d{6}$/.test(issueId)) {
    const sequence = Number(issueId.slice(4));
    return `${issueId.slice(0, 4)} 年${sequence > 90 ? `增刊 ${sequence % 90}` : `第 ${sequence} 期`}`;
  }
  return issueId;
}

export function isArchiveIssueId(publication: ArchivePublicationName, issueId: string): boolean {
  return ARCHIVE_PUBLICATION_BY_ID[publication].type === "newspaper"
    ? /^\d{8}$/.test(issueId)
    : /^\d{6}$/.test(issueId);
}

export function dateToIssueId(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

export function issueIdToDate(issueId: string): Date {
  if (!/^\d{8}$/.test(issueId)) return new Date();
  return new Date(Number(issueId.slice(0, 4)), Number(issueId.slice(4, 6)) - 1, Number(issueId.slice(6, 8)), 12);
}

const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1_000;
export const RMRB_DAILY_AVAILABLE_HOUR = 19;

export function getLatestRmrbAvailableDate(now = new Date()): string {
  const chinaNow = new Date(now.getTime() + CHINA_TIME_OFFSET_MS);
  if (chinaNow.getUTCHours() < RMRB_DAILY_AVAILABLE_HOUR) chinaNow.setUTCDate(chinaNow.getUTCDate() - 1);
  return [
    String(chinaNow.getUTCFullYear()).padStart(4, "0"),
    String(chinaNow.getUTCMonth() + 1).padStart(2, "0"),
    String(chinaNow.getUTCDate()).padStart(2, "0"),
  ].join("");
}

// Inclusive gaps in the protected archive. Keep this domain rule in the shared
// package so Web and native date pickers cannot offer known-missing issues.
const RMRB_MISSING_RANGES: ReadonlyArray<readonly [string, string]> = [
  ["19460628", "19460630"], ["19460708", "19460708"], ["19460902", "19460902"],
  ["19470102", "19470104"], ["19470123", "19470123"], ["19470516", "19470516"],
  ["19470702", "19470702"], ["19470902", "19470902"], ["19480102", "19480104"],
  ["19480210", "19480210"], ["19480516", "19480516"], ["19480902", "19480902"],
  ["19490102", "19490102"], ["19490130", "19490130"], ["19490502", "19490502"],
  ["19490708", "19490708"], ["19491007", "19491007"], ["19500102", "19500102"],
  ["19500218", "19500219"], ["19500502", "19500502"], ["19510102", "19510102"],
  ["19510206", "19510206"], ["19510502", "19510502"], ["19520102", "19520102"],
  ["19520127", "19520128"], ["19520502", "19520502"], ["19530102", "19530102"],
  ["19530215", "19530215"], ["19530502", "19530502"], ["19531002", "19531002"],
  ["19540102", "19540102"], ["19540203", "19540203"], ["19540502", "19540502"],
  ["20030417", "20030419"], ["20030421", "20030422"], ["20030424", "20030430"],
  ["20041206", "20041206"], ["20070101", "20070101"], ["20100611", "20100630"],
  ["20101224", "20101225"], ["20111030", "20111030"], ["20120524", "20120524"],
  ["20130101", "20140110"],
];

// CKXX's 925 missing dates encoded as a per-year day-of-year bitset. Each two
// hex characters represent eight days, least-significant bit first.
const CKXX_MISSING_DATE_BITS: Readonly<Record<string, string>> = {
  1957: "0000000000000000000000000000000200000000000000000000000000f0ffffffff070000000000000000000000",
  1958: "0200000000000e0000000000000000020000000000000008040280402010080402814c2010080402814020100804",
  1959: "12080402c1432010080402814020100a0402814020100804028140201008040281403c1008040281402010080402",
  1960: "030402794020100804028140201008060281402010080402814020100804028180201c0804028140201008040201",
  1961: "0381402010e801028140201008040283402010080402814020100804028140201008068140201008040281402010",
  1962: "412010083c0281402010080402814021100804028140201008040281402010080402874020100804028140201010",
  1963: "2110080f02814020ffff7f03814000130804028140201008040281402010080402014e2010080402814020100804",
  1964: "110804028178201008040281402010060402814020100804028140201008040281401c1008040285402010080402",
  1965: "010281802710080402814020100804038140201008040281402010080402814060710e0402814020100804028100",
  1966: "0381f0402010080402814020100804038140201008040281402010080402814020100e040281402010c8ffffff1f",
  1967: "03814020100804028140201008040283402010080402e1ffffff0f040281402010080e0281402010080402814000",
  1968: "834020e009040281402010080402014c201008040281402010080402814020100804388140201008040281402000",
  1969: "26100804028147201008040281402012080402814020100804028140201008040201040000000000000000000000",
  1971: "0000000000000000000000000000000000000000000000000000f0ffffffffffffff010000000000000000000000",
  1972: "00000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000",
  1973: "00000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000",
  1974: "0000000000000000000000000000000000000000000000000000000000000000000000000000000000c0ffffff1f",
  1980: "00000000004000000000000000000002000000000000000000000000000000000000040000000000000000000000",
  1981: "01000000080000000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1982: "01000001000000000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1983: "01000000000800000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1984: "01000000010000000000000000000002000000000000000000000000000000000000040000000000000000000000",
  1985: "01000000000004000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1986: "01000000800000000000000000000001000001000000000000000000000000000000020000000000000000000000",
  1987: "01000010000000000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1988: "01000000008000000000000000000002000000000000000000000000000000040000000100000000000000000000",
  1990: "01000004000000000000000000000001000000000000000000000000000000000000000000000000000000000000",
  1991: "01000000000000000000000000000001000000000000000000000000000000000000020000000000000000000000",
  1992: "01000000040000000000000000000002000000000000000000000000000000000000040000000000000000000000",
  1996: "00000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000",
};

function parseCalendarIssueId(issueId: string): { year: number; dayIndex: number } | null {
  if (!/^\d{8}$/.test(issueId)) return null;
  const year = Number(issueId.slice(0, 4));
  const month = Number(issueId.slice(4, 6));
  const day = Number(issueId.slice(6, 8));
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return { year, dayIndex: Math.floor((timestamp - Date.UTC(year, 0, 1)) / 86_400_000) };
}

function isCkxxMissing(issueId: string, year: number, dayIndex: number): boolean {
  if (year === 1989) return true;
  const bits = CKXX_MISSING_DATE_BITS[String(year)];
  if (!bits) return false;
  const byte = Number.parseInt(bits.slice(Math.floor(dayIndex / 8) * 2, Math.floor(dayIndex / 8) * 2 + 2), 16);
  return (byte & (1 << (dayIndex % 8))) !== 0;
}

export function isArchiveNewspaperIssueAvailable(
  publication: "rmrb" | "ckxx",
  issueId: string,
  now = new Date(),
): boolean {
  const parsed = parseCalendarIssueId(issueId);
  if (!parsed) return false;
  if (publication === "rmrb") {
    if (issueId < "19460515" || issueId > getLatestRmrbAvailableDate(now)) return false;
    return !RMRB_MISSING_RANGES.some(([start, end]) => issueId >= start && issueId <= end);
  }
  if (issueId < "19570301" || issueId > "19981231") return false;
  return !isCkxxMissing(issueId, parsed.year, parsed.dayIndex);
}

export function toSearchApiDate(issueId: string): string {
  return issueId.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

export function stripSearchHighlights(value: string): string {
  return value.replaceAll("@highlight@", "").replaceAll("@/highlight@", "");
}
