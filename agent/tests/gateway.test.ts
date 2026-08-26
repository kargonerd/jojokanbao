import { describe, expect, it } from "vitest";
import { onRequest } from "../../infrastructure/edgeone/functions/gateway/[[default]]";

function context(pathname: string) {
  return {
    env: {},
    request: new Request(`https://agent.example${pathname}`, {
      headers: { "Makers-Conversation-Id": "gateway-test" },
    }),
  } as Parameters<typeof onRequest>[0];
}

describe("EdgeOne gateway", () => {
  it("does not expose the removed buffered Agent proxy", async () => {
    const response = await onRequest(context("/gateway/ask"));
    expect(response.status).toBe(404);
  });

  it("routes credential administration and rejects unknown paths", async () => {
    expect((await onRequest(context("/gateway/credentials"))).status).toBe(405);
    expect((await onRequest(context("/gateway/conversations"))).status).toBe(404);
    expect((await onRequest(context("/gateway/unknown"))).status).toBe(404);
  });
});
