import type { AdminPermission } from "../auth/session";

export const adminNavigation: { to: string; label: string; description: string; permission: AdminPermission; icon: string }[] = [
  { to: "/content", label: "书库管理", description: "导入书籍、预览内容，设置阅读范围并发布。", permission: "library", icon: "book" },
  { to: "/pdf", label: "报刊管理", description: "整理报刊 PDF，完成命名、拆页和发布。", permission: "operations", icon: "paper" },
  { to: "/es", label: "搜索数据", description: "查找索引中的内容，修复或移除异常数据。", permission: "operations", icon: "search" },
  { to: "/moderation", label: "评论审核", description: "查看读者举报，处理评论并反馈审核结果。", permission: "moderation", icon: "comments" },
  { to: "/rmrb-review", label: "正文复核", description: "核对人民日报缺失正文，保存复核结果。", permission: "operations", icon: "check" },
  { to: "/agent", label: "Agent 管理", description: "检查模型服务连接，更新专用登录凭据。", permission: "agent", icon: "agent" },
];

export function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7v11h-7v-7h-4v7H3z",
    book: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zM12 6v16",
    paper: "M5 3h14v18H5zM8 7h8M8 11h8M8 15h3M13 15h3",
    search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    comments: "M3 4h18v13H9l-6 4zM7 8h10M7 12h7",
    check: "M8 3H4v18h16V3h-4M8 2h8v4H8zM8 13l3 3 6-7",
    agent: "M5 7h14v13H5zM12 3v4M9 11v3M15 11v3M9 17h6",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d={paths[name] || paths.home} /></svg>;
}
