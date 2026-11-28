import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "../src/random-uuid";

const nativeRandomUUID = crypto.randomUUID;

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", { configurable: true, writable: true, value: nativeRandomUUID });
});

describe("randomUUID 垫片", () => {
  it("优先用原生实现", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("缺少 crypto.randomUUID 时生成 v4 uuid", () => {
    Reflect.deleteProperty(crypto, "randomUUID");
    const value = randomUUID();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID()).not.toBe(value);
  });
});
