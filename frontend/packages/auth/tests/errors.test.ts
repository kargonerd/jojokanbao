import { describe, expect, it } from "vitest";
import { getAuthErrorMessage } from "../src/errors";

describe("getAuthErrorMessage", () => {
  it("translates stable Supabase error codes", () => {
    expect(getAuthErrorMessage({ code: "invalid_credentials" })).toBe("邮箱或密码不正确。");
  });

  it("does not expose an unknown backend error message", () => {
    expect(getAuthErrorMessage({ message: "internal table name leaked" })).toBe("操作没有完成，请检查填写内容后重试。");
  });
});
