export const DONATION_RECORDS_URL = "https://docs.qq.com/sheet/DZlhxZUdmalFBUUFQ?tab=BB08J2";

// First launch / unavailable remote config fallback, shared by display and copy.
export const FEEDBACK_QQ_GROUP = "974380749";
export const SUPPORT_CONFIG_KEY = "support_config";
export interface SupportConfig { qqGroup: string }
export const DEFAULT_SUPPORT_CONFIG: SupportConfig = { qqGroup: FEEDBACK_QQ_GROUP };
export function parseSupportConfig(value: unknown): SupportConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const qqGroup = (value as Record<string, unknown>).qqGroup;
  return typeof qqGroup === "string" && /^[1-9][0-9]{4,11}$/.test(qqGroup) ? { qqGroup } : undefined;
}
export const FEEDBACK_BILIBILI_URL = "https://space.bilibili.com/571556400";

export const PROJECT_COPYRIGHT_NOTICES = [
  "本项目部分内容为公开报刊书籍历史资料扫描整理，仅供个人学习、学术研究使用。",
  "报刊书籍文字、图片、版式之著作权归原出版机构及相关著作权人所有。",
  "若著作权人发现本项目内容侵害自身合法权益，可提供权属证明联系我们，收到通知后我们将及时移除相关资料。",
  "未经原权利人许可，请勿转载、复制、二次分发本项目内书籍报刊等扫描资料。",
] as const;
