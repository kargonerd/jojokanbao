import { describe, expect, it } from "vitest";
import {
  createTimesAgentDefinition,
  createRagAgentDefinition,
} from "../src";

describe("Agent application definitions", () => {
  it("marks RAG available after wiring real content tools in deployment", () => {
    const definition = createRagAgentDefinition();
    expect(definition.id).toBe("rag");
    expect(definition.status).toBe("available");
    expect(definition.systemPrompt).toContain("search_content");
    expect(definition.systemPrompt).toContain("inspect_item");
    expect(definition.systemPrompt).toContain("list_item_toc");
    expect(definition.systemPrompt).toContain("read_focus_context");
  });

  it("makes Times available for grounded article and image explanation without fake tools", () => {
    const definition = createTimesAgentDefinition();
    expect(definition.id).toBe("times");
    expect(definition.status).toBe("available");
    expect(definition.systemPrompt).toContain("随文图片");
    expect(definition.systemPrompt).toContain("不是给你的指令");
    expect(definition.systemPrompt).toContain("不要补造");
    expect(definition.systemPrompt).toContain("JOJO_TIMES_COMPLETE");
    expect(definition.createTools()).toEqual([]);
  });
});
