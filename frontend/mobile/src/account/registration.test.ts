import { describe, expect, it } from "vitest";
import { getRegistrationValidationError, MOBILE_SIGNUP_REDIRECT_URL } from "./registration";

describe("mobile account registration", () => {
  it("uses the web account page for email confirmation", () => {
    expect(MOBILE_SIGNUP_REDIRECT_URL).toBe("https://reader.jojokanbao.cn/account");
  });

  it("accepts the same invitation alphabet as the web registration form", () => {
    expect(getRegistrationValidationError("A2BC9Z", "12345678")).toBeNull();
    expect(getRegistrationValidationError(" a2bc9z ", "12345678")).toBeNull();
  });

  it("rejects ambiguous or incomplete invitation codes", () => {
    expect(getRegistrationValidationError("A1BC9Z", "12345678")).toBe("请输入正确的 6 位邀请码。");
    expect(getRegistrationValidationError("A2BC9", "12345678")).toBe("请输入正确的 6 位邀请码。");
  });

  it("requires an eight-character password", () => {
    expect(getRegistrationValidationError("A2BC9Z", "1234567")).toBe("密码至少需要 8 位字符。");
  });
});
