const INVITATION_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/i;

export function getRegistrationValidationError(invitationCode: string, password: string): string | null {
  if (!INVITATION_CODE_PATTERN.test(invitationCode.trim())) {
    return "请输入正确的 6 位邀请码。";
  }
  if (password.length < 8) {
    return "密码至少需要 8 位字符。";
  }
  return null;
}
