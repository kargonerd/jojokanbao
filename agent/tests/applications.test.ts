import { describe, expect, it } from "vitest";
import {
  createOldsAgentDefinition,
  createRagAgentDefinition,
} from "../src";

describe("Agent applications", () => {
  it("marks RAG available after remote document tools are connected", () => {
    const definition = createRagAgentDefinition();
    expect(definition.id).toBe("rag");
    expect(definition.status).toBe("available");
    expect(definition.createTools()).toEqual([]);
  });

  it("keeps Olds as a placeholder without fake tools", () => {
    const definition = createOldsAgentDefinition();
    expect(definition.id).toBe("olds");
    expect(definition.status).toBe("placeholder");
    expect(definition.createTools()).toEqual([]);
  });
});
