const AUTH_ERROR_MESSAGES: Record<string, string> = {
  profile_request_timeout: "读者代号暂时无法读取，请检查网络后重试。",
  password_recovery_required: "请重新验证要找回的邮箱，再设置新密码。",
  anonymous_provider_disabled: "当前未开放匿名登录。",
  email_address_invalid: "邮箱地址格式不正确，请检查 @ 前后的内容，例如 name@qq.com。",
  email_address_not_authorized: "当前邮件服务不能向这个地址发送确认邮件。",
  email_exists: "这个邮箱已经注册，请直接登录。",
  email_not_confirmed: "请先输入邮件中的验证码，完成邮箱验证。",
  otp_expired: "验证码已过期，请重新发送。",
  otp_disabled: "验证码登录暂不可用。",
  invalid_credentials: "邮箱或密码不正确。",
  over_email_send_rate_limit: "邮件发送过于频繁，请稍后再试。",
  over_request_rate_limit: "请求过于频繁，请稍后再试。",
  same_password: "新密码不能与当前密码相同。",
  signup_disabled: "当前暂未开放注册。",
  user_already_exists: "这个邮箱已经注册，请直接登录。",
  weak_password: "密码强度不足，请至少使用 8 位字符。",
};

export function getAuthErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "操作没有完成，请稍后再试。";

  const candidate = error as { code?: string; message?: string; status?: number };
  if (candidate.code && AUTH_ERROR_MESSAGES[candidate.code]) {
    return AUTH_ERROR_MESSAGES[candidate.code]!;
  }

  const message = candidate.message?.toLowerCase() ?? "";
  if (message.includes("invalid recipient") || message.includes("recipient address rejected")) {
    return "这个邮箱无法接收验证邮件，请检查邮箱地址，或换一个邮箱后重试。";
  }
  // Auth hides the underlying SMTP rejection from browsers. A send failure
  // can also be a provider outage, so guide the reader without claiming that
  // every HTTP 500 means their address is invalid.
  if (/error sending (confirmation|recovery|magic link|invite|email change) (email|mail)/.test(message)) {
    return "验证邮件发送失败，请先检查邮箱地址是否填写正确（例如 name@qq.com）；确认无误后稍后重试。";
  }
  if (message.includes("invalid login credentials")) return "邮箱或密码不正确。";
  if (message.includes("email not confirmed")) return "请先输入邮件中的验证码，完成邮箱验证。";
  if (message.includes("token has expired") || message.includes("otp expired")) {
    return "验证码已过期，请重新发送。";
  }
  if (message.includes("token") && message.includes("invalid")) {
    return "验证码不正确，请检查后重试。";
  }
  if (message.includes("reauthentication")) return "当前密码不正确。";
  if (message.includes("user already registered")) return "这个邮箱已经注册，请直接登录。";
  if (message.includes("invite code") || message.includes("invitation code")) {
    return "邀请码无效、已过期、已用完，或与当前邮箱不匹配。";
  }
  if (message.includes("personal invitation has already been redeemed")) {
    return "你的邀请码已经被使用，不能再次生成。";
  }
  if (message.includes("personal invitation has been disabled")) {
    return "你的邀请码已被停用，请联系管理员。";
  }
  if (message.includes("rate limit")) return "请求过于频繁，请稍后再试。";
  if (message.includes("failed to fetch")) return "暂时无法连接账号服务，请检查网络后重试。";
  return candidate.status && candidate.status >= 500
    ? "账号服务暂时不可用，请稍后再试。"
    : "操作没有完成，请检查填写内容后重试。";
}
