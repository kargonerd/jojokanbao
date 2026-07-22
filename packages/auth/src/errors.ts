const AUTH_ERROR_MESSAGES: Record<string, string> = {
  anonymous_provider_disabled: "当前未开放匿名登录。",
  email_address_invalid: "邮箱地址格式不正确。",
  email_not_confirmed: "请先打开确认邮件，完成邮箱验证。",
  invalid_credentials: "邮箱或密码不正确。",
  over_email_send_rate_limit: "邮件发送过于频繁，请稍后再试。",
  over_request_rate_limit: "请求过于频繁，请稍后再试。",
  same_password: "新密码不能与当前密码相同。",
  weak_password: "密码强度不足，请至少使用 8 位字符。",
};

export function getAuthErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "操作没有完成，请稍后再试。";

  const candidate = error as { code?: string; message?: string; status?: number };
  if (candidate.code && AUTH_ERROR_MESSAGES[candidate.code]) {
    return AUTH_ERROR_MESSAGES[candidate.code]!;
  }

  const message = candidate.message?.toLowerCase() ?? "";
  if (message.includes("invalid login credentials")) return "邮箱或密码不正确。";
  if (message.includes("email not confirmed")) return "请先打开确认邮件，完成邮箱验证。";
  if (message.includes("rate limit")) return "请求过于频繁，请稍后再试。";
  if (message.includes("failed to fetch")) return "暂时无法连接账号服务，请检查网络后重试。";
  return candidate.status && candidate.status >= 500
    ? "账号服务暂时不可用，请稍后再试。"
    : "操作没有完成，请检查填写内容后重试。";
}
