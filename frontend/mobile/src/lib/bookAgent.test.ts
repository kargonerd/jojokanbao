import { describe, expect, it, vi } from "vitest";
import { parseAgentSseFrames } from "./bookAgent";

describe("mobile book agent stream", () => {
  it("parses complete SSE frames and preserves a partial frame", () => {
    const listener = vi.fn();
    const remainder = parseAgentSseFrames(
      'event: text_delta\ndata: {"delta":"回答"}\n\nevent: done\ndata: {',
      listener,
    );
    expect(listener).toHaveBeenCalledWith("text_delta", { delta: "回答" });
    expect(remainder).toBe("event: done\ndata: {");
  });
});
