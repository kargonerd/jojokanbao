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

  it("keeps Times as a placeholder without fake tools", () => {
    const definition = createTimesAgentDefinition();
    expect(definition.id).toBe("times");
    expect(definition.status).toBe("placeholder");
    expect(definition.createTools()).toEqual([]);
  });
});
