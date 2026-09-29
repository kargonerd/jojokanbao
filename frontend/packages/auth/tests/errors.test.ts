import { describe, expect, it } from "vitest";
import { getAuthErrorMessage } from "../src/errors";

describe("getAuthErrorMessage", () => {
  it("gives actionable guidance for the public SMTP failure without misdiagnosing all server errors", () => {
    expect(getAuthErrorMessage({ code: "unexpected_failure", status: 500, message: "Error sending confirmation email" }))
      .toContain("请先检查邮箱地址");
    expect(getAuthErrorMessage({ code: "unexpected_failure", status: 500, message: "Database error saving new user" }))
      .toBe("账号服务暂时不可用，请稍后再试。");
    expect(getAuthErrorMessage({ status: 500, message: "550 Invalid recipient" }))
      .toContain("这个邮箱无法接收验证邮件");
  });
  it("translates stable Supabase error codes", () => {
    expect(getAuthErrorMessage({ code: "invalid_credentials" })).toBe("邮箱或密码不正确。");
  });

  it("explains a redeemed personal invitation", () => {
    expect(
      getAuthErrorMessage({
        message: "Personal invitation has already been redeemed.",
      }),
    ).toBe("你的邀请码已经被使用，不能再次生成。");
  });

  it("explains an administratively disabled personal invitation", () => {
    expect(
      getAuthErrorMessage({
        message: "Personal invitation has been disabled.",
      }),
    ).toBe("你的邀请码已被停用，请联系管理员。");
  });

  it("does not expose an unknown backend error message", () => {
    expect(getAuthErrorMessage({ message: "internal table name leaked" })).toBe("操作没有完成，请检查填写内容后重试。");
  });

  it("translates invitation hook rejections", () => {
    expect(getAuthErrorMessage({ message: "Invite code is invalid or unavailable." })).toBe(
      "邀请码无效、已过期、已用完，或与当前邮箱不匹配。",
    );
    expect(getAuthErrorMessage({ message: "Invitation code is required or invalid." })).toBe(
      "邀请码无效、已过期、已用完，或与当前邮箱不匹配。",
    );
  });

  it("names the registration service instead of blaming the form", () => {
    expect(getAuthErrorMessage({ code: "remote_config_unavailable", status: 503 })).toBe("注册服务暂时不可用，请稍后重试。");
    expect(getAuthErrorMessage({ code: "signup_authorization_failed", status: 502 })).toBe("注册服务暂时不可用，请稍后重试。");
    expect(getAuthErrorMessage({ code: "signup_service_unreachable" })).toBe("无法连接注册服务，请检查网络后重试。");
    expect(getAuthErrorMessage({ code: "invitation_required", status: 400 })).toBe("注册需要 6 位邀请码，请填写邀请码后重试。");
    expect(getAuthErrorMessage({ status: 503, message: "注册服务暂时不可用，请稍后重试。" })).toBe("账号服务暂时不可用，请稍后再试。");
  });

  it("explains an expired signup authorization", () => {
    expect(getAuthErrorMessage({ message: "Registration authorization is invalid or expired. Please retry signup." })).toBe(
      "注册授权已过期，请重新发送验证码后再试。",
    );
  });
});
