// Browser type=email accepts single-label domains, including a reversed
// address such as qq.com@123456. Public registration needs a full domain.
export function validateRegistrationEmail(email: string): string {
  const normalized = email.trim();
  const domain = normalized.split("@")[1] ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    || /^\d+$/.test(domain.split(".").at(-1) ?? "")) {
    throw { code: "email_address_invalid" };
  }
  return normalized;
}
