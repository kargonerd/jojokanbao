import { describe, expect, it } from "vitest";
import { createRagAgentDefinition, RAG_AGENT_ID } from "../src";

describe("RAG Agent definition", () => {
  it("exposes an explicit placeholder without fake retrieval tools", () => {
    const definition = createRagAgentDefinition();

    expect(definition.id).toBe(RAG_AGENT_ID);
    expect(definition.status).toBe("placeholder");
    expect(definition.systemPrompt).toContain("尚未接入");
    expect(definition.createTools()).toEqual([]);
  });
});
