import { describe, expect, it, vi } from "vitest";

/**
 * `agentGateway.ts` reads `import.meta.env` at module scope, so each assertion
 * about a configured base needs a fresh module instance.
 */
async function loadGateway(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, undefined as unknown as string);
    else vi.stubEnv(key, value);
  }
  return import("../src/api/agentGateway");
}

describe("unified Agent entry point", () => {
  it("defaults to the international Agent origin and always returns an absolute URL", async () => {
    const { agentAskUrl } = await loadGateway({
      VITE_AGENT_API_BASE: undefined,
      VITE_READER_API_BASE: undefined,
    });

    expect(agentAskUrl("/ask")).toBe("https://agent-global.jojokanbao.cn/ask");
    expect(agentAskUrl("/ask/times")).toBe("https://agent-global.jojokanbao.cn/ask/times");
  });

  it("honours a configured Agent base and tolerates a trailing slash", async () => {
    const { agentAskUrl } = await loadGateway({
      VITE_AGENT_API_BASE: "https://beta-agent.jojokanbao.cn/",
      VITE_READER_API_BASE: undefined,
    });

    expect(agentAskUrl("/ask")).toBe("https://beta-agent.jojokanbao.cn/ask");
    expect(agentAskUrl("/ask/times")).toBe("https://beta-agent.jojokanbao.cn/ask/times");
  });

  it("keeps Reader APIs on the Web client's own origin by default", async () => {
    const { readerApiUrl } = await loadGateway({
      VITE_AGENT_API_BASE: undefined,
      VITE_READER_API_BASE: undefined,
    });

    expect(readerApiUrl("/api/v1/speech")).toBe("/api/v1/speech");
    expect(readerApiUrl("/api/v1/speech/providers")).toBe("/api/v1/speech/providers");
    expect(readerApiUrl("/api/v1/account/signup-authorization"))
      .toBe("/api/v1/account/signup-authorization");
  });

  it("keeps the Agent origin and the Reader origin independent", async () => {
    const { agentAskUrl, readerApiUrl } = await loadGateway({
      VITE_AGENT_API_BASE: "https://agent-global.jojokanbao.cn",
      VITE_READER_API_BASE: "https://reader.jojokanbao.cn",
    });

    expect(agentAskUrl("/ask")).toBe("https://agent-global.jojokanbao.cn/ask");
    expect(readerApiUrl("/api/v1/speech")).toBe("https://reader.jojokanbao.cn/api/v1/speech");
  });

  it("routes Desktop through its privileged streaming protocol via the shared base", async () => {
    const { agentAskUrl, readerApiUrl } = await loadGateway({
      VITE_AGENT_API_BASE: "jojo-agent://reader",
      VITE_READER_API_BASE: "jojo-agent://reader",
    });

    expect(agentAskUrl("/ask")).toBe("jojo-agent://reader/ask");
    expect(agentAskUrl("/ask/times")).toBe("jojo-agent://reader/ask/times");
    expect(readerApiUrl("/api/v1/speech")).toBe("jojo-agent://reader/api/v1/speech");
  });
});
