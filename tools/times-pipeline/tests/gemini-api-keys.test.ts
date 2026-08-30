import { describe, expect, it } from "vitest";
import { geminiApiKeysFromEnvironment, normalizeGeminiApiKeys } from "../src/translation/api-keys.js";

describe("Gemini API key configuration", () => {
  it("discovers the legacy key and any numbered project keys in numeric order", () => {
    expect(geminiApiKeysFromEnvironment({
      GEMINI_API_KEY: " primary ",
      GEMINI_API_KEY_10: "tenth",
      GEMINI_API_KEY_2: "second",
      GEMINI_API_KEY_3: "primary",
    })).toEqual(["primary", "second", "tenth"]);
  });

  it("uses GEMINI_API_KEYS as the explicit ordered pool", () => {
    expect(geminiApiKeysFromEnvironment({
      GEMINI_API_KEYS: " project-a,project-b\nproject-c;project-a ",
      GEMINI_API_KEY: "legacy-is-ignored",
      GEMINI_API_KEY_2: "numbered-is-ignored",
    })).toEqual(["project-a", "project-b", "project-c"]);
  });

  it("normalizes programmatic keys while retaining the single-key API", () => {
    expect(normalizeGeminiApiKeys([" a ", "b", "a"], " legacy ")).toEqual(["a", "b", "legacy"]);
    expect(normalizeGeminiApiKeys(undefined, " legacy ")).toEqual(["legacy"]);
  });
});
