import { describe, expect, it } from "vitest";
import { createOldsAgentDefinition, OLDS_AGENT_ID } from "../src";

describe("Olds Agent definition", () => {
  it("exposes an explicit placeholder without fake search tools", () => {
    const definition = createOldsAgentDefinition();

    expect(definition.id).toBe(OLDS_AGENT_ID);
    expect(definition.status).toBe("placeholder");
    expect(definition.systemPrompt).toContain("尚未接入");
    expect(definition.createTools()).toEqual([]);
  });
});
