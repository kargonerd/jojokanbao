import { describe, expect, it } from "vitest";
import { getAuthErrorMessage } from "../src/errors";

describe("getAuthErrorMessage", () => {
  it("translates stable Supabase error codes", () => {
    expect(getAuthErrorMessage({ code: "invalid_credentials" })).toBe("邮箱或密码不正确。");
  });

  it("does not expose an unknown backend error message", () => {
    expect(getAuthErrorMessage({ message: "internal table name leaked" })).toBe("操作没有完成，请检查填写内容后重试。");
  });

  it("translates invitation hook rejections", () => {
    expect(getAuthErrorMessage({ message: "Invite code is invalid or unavailable." })).toBe(
      "邀请码无效、已过期、已用完，或与当前邮箱不匹配。",
    );
  });
});
