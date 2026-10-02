import {
  ARCHIVE_PUBLICATION_NAMES,
  type ArchivePublicationName,
} from "@jojo/content";

/**
 * 报刊配置数据 — 从原 Vue 项目迁移
 *
 * 可读性（年份范围、期数列表、报纸缺档日期）全部由 Delivery 数据层推导：
 * 杂志经数据集索引枚举期次（useArchiveIssueIndex），报纸经索引中的
 * 自适应日历判定日期（isAdaptiveCalendarDateAvailable）。本文件只保留
 * 展示与功能开关，不再维护任何期数表或黑名单。
 */

// ─── 公共接口 ───

export const PUBLICATION_NAMES = ARCHIVE_PUBLICATION_NAMES;
export type PublicationName = ArchivePublicationName;

export interface PublicationConfig {
  name: PublicationName;
  label: string;
  type: "newspaper" | "magazine";
  defaultId: string;
  genSeqText?: (seq: number) => string;
  pageOutlineAvailable?: (id: string) => boolean;
  enableTextLayer?: boolean;
  resolutionControl?: boolean;
}

function genSeqTextDefault(seq: number): string {
  if (seq > 90) return '增刊' + (seq % 90);
  return '第' + seq + '期';
}

function hasRmrbPageOutline(id: string): boolean {
  const year = Number(id.slice(0, 4));
  return (year >= 1946 && year <= 1947)
    || (year >= 1949 && year <= 2007)
    || (year >= 2011 && year <= 2012);
}

export const PUBLICATIONS: Record<PublicationName, PublicationConfig> = {
  rmrb: {
    name: "rmrb", label: "人民日报", type: "newspaper", defaultId: "19760910",
    resolutionControl: true,
    // Audited against representative local issues for every year. Some 2011
    // and 2012 issues still contain only production codes; the reader applies
    // a second content-level filter before showing the outline button.
    pageOutlineAvailable: hasRmrbPageOutline,
  },
  ckxx: {
    name: "ckxx", label: "参考消息", type: "newspaper", defaultId: "19760910",
  },
  hq: {
    name: "hq", label: "红旗", type: "magazine", defaultId: "196419",
    genSeqText: genSeqTextDefault,
  },
  rmhb: {
    name: "rmhb", label: "人民画报", type: "magazine", defaultId: "197292",
    genSeqText: genSeqTextDefault,
  },
  sjzs: {
    name: "sjzs", label: "世界知识", type: "magazine", defaultId: "196513",
    genSeqText: genSeqTextDefault,
    enableTextLayer: true,
  },
};
