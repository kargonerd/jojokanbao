import { describe, expect, it } from "vitest";
import { agentGatewayUrl } from "../src/api/agentGateway";

describe("agent gateway URL", () => {
  it("keeps Web requests on the current Reader origin", () => {
    expect(agentGatewayUrl("/gateway/ask", undefined)).toBe("/gateway/ask");
    expect(agentGatewayUrl("/gateway/times/explain", "")).toBe("/gateway/times/explain");
  });

  it("routes Desktop requests through its privileged streaming protocol", () => {
    expect(agentGatewayUrl("/gateway/ask", "jojo-agent://reader"))
      .toBe("jojo-agent://reader/gateway/ask");
    expect(agentGatewayUrl("/gateway/times/explain", "jojo-agent://reader"))
      .toBe("jojo-agent://reader/gateway/times/explain");
  });
});
