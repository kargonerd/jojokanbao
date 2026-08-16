import type { FeatureFlagDefinition, FeatureFlagRule } from "./types";

function rule(
  name: string,
  conditionType: FeatureFlagRule["conditionType"],
  serve: boolean,
  options: Partial<FeatureFlagRule> = {},
): FeatureFlagRule {
  return {
    id: crypto.randomUUID(),
    name,
    conditionType,
    serve,
    percentage: null,
    bucketBy: null,
    bucketSalt: null,
    startsAt: null,
    endsAt: null,
    enabled: true,
    isFallback: false,
    userIds: [],
    ...options,
  };
}

const updatedAt = "2026-08-16T01:30:00.000Z";

export const previewFeatureFlags: FeatureFlagDefinition[] = [
  {
    key: "agent.chat",
    description: "JOJO Agent 对话入口和模型请求",
    revision: 7,
    updatedAt,
    updatedBy: "preview-admin",
    rules: [
      rule("内部测试用户", "users", true, {
        userIds: ["4e2e6880-jojo-preview-reader"],
      }),
      rule("首批灰度", "percentage", true, {
        percentage: 10,
        bucketBy: "user",
        bucketSalt: "agent-chat-r1",
      }),
      rule("默认关闭", "global", false, { isFallback: true }),
    ],
  },
  {
    key: "library.bookshelf",
    description: "登录读者的服务端书架",
    revision: 3,
    updatedAt,
    updatedBy: "preview-admin",
    rules: [
      rule("已登录读者", "authenticated", true),
      rule("默认关闭", "global", false, { isFallback: true }),
    ],
  },
  {
    key: "olds.workspace",
    description: "尚未完成的旧闻工作区",
    revision: 1,
    updatedAt,
    updatedBy: null,
    rules: [rule("整体关闭", "global", false, { isFallback: true })],
  },
  {
    key: "rag.workspace",
    description: "RAG 工作区路由与导航",
    revision: 2,
    updatedAt,
    updatedBy: "preview-admin",
    rules: [
      rule("内部测试用户", "users", true),
      rule("默认关闭", "global", false, { isFallback: true }),
    ],
  },
  {
    key: "reader.annotations",
    description: "划线、想法和 AI 解释数据",
    revision: 2,
    updatedAt,
    updatedBy: "preview-admin",
    rules: [
      rule("已登录读者", "authenticated", true),
      rule("默认关闭", "global", false, { isFallback: true }),
    ],
  },
];
