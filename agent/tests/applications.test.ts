import { describe, expect, it } from "vitest";
import {
  createOldsAgentDefinition,
  createRagAgentDefinition,
} from "../src";

describe("Agent application placeholders", () => {
  it.each([
    ["rag", createRagAgentDefinition],
    ["olds", createOldsAgentDefinition],
  ])("%s has no fake tools", (id, createDefinition) => {
    const definition = createDefinition();

    expect(definition.id).toBe(id);
    expect(definition.status).toBe("placeholder");
    expect(definition.createTools()).toEqual([]);
  });
});
