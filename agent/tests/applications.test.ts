import { describe, expect, it } from "vitest";
import {
  createOldsAgentDefinition,
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
  });

  it("keeps Olds as a placeholder without fake tools", () => {
    const definition = createOldsAgentDefinition();
    expect(definition.id).toBe("olds");
    expect(definition.status).toBe("placeholder");
    expect(definition.createTools()).toEqual([]);
  });
});
