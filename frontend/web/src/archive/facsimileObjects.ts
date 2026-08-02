/**
 * RMRB object paths that EdgeOne incorrectly answers with a direct 403.
 *
 * The public issue route remains stable. Only the backing protected-PDF object
 * is revisioned so existing links, bookmarks, and date navigation keep working.
 */
export const RMRB_EDGEONE_BLOCKED_ISSUES = [
  "19580504",
  "19581123",
  "19610423",
  "19660420",
  "19670805",
  "19740718",
  "19760120",
  "19890625",
  "19890626",
  "20080618",
  "20080821",
  "20081025",
  "20081229",
  "20090430",
  "20100716",
  "20110220",
  "20110702",
  "20121118",
  "20121120",
  "20121225",
  "20140706",
  "20150116",
  "20150521",
  "20150618",
  "20150904",
  "20150905",
  "20151205",
  "20160107",
  "20160905",
  "20170125",
  "20170222",
  "20170427",
  "20170817",
  "20171217",
  "20190204",
  "20190703",
  "20200122",
  "20210302",
  "20210812",
  "20221206",
  "20221208",
  "20230131",
  "20231001",
  "20231111",
  "20241006",
  "20250620",
  "20250920",
  "20251121",
  "20260121",
  "20260509",
  "20260521",
] as const;

const rmrbEdgeOneBlockedIssues = new Set<string>(RMRB_EDGEONE_BLOCKED_ISSUES);

export function getFacsimileIssueFilename(name: string, issueId: string): string {
  return name === "rmrb" && rmrbEdgeOneBlockedIssues.has(issueId)
    ? `${issueId}-r1.pdf`
    : `${issueId}.pdf`;
}
