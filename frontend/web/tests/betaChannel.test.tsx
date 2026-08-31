import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { applyBetaMetadata, isBetaHostname, isBetaRelease } from "../src/betaChannel";
import { AppHeader } from "../src/shell/AppHeader";

afterEach(() => {
  cleanup();
  document.head.querySelector('meta[name="robots"]')?.remove();
  delete document.documentElement.dataset.releaseChannel;
});

describe("public beta channel", () => {
  it("recognizes only the dedicated beta hostname", () => {
    expect(isBetaHostname("beta.jojokanbao.cn")).toBe(true);
    expect(isBetaHostname("BETA.JOJOKANBAO.CN")).toBe(true);
    expect(isBetaHostname("www.jojokanbao.cn")).toBe(false);
    expect(isBetaHostname("beta.jojokanbao.cn.example.com")).toBe(false);
    expect(isBetaRelease("preview.example.com", "beta")).toBe(true);
    expect(isBetaRelease("preview.example.com", "stable")).toBe(false);
  });

  it("adds idempotent noindex metadata on the beta hostname", () => {
    expect(applyBetaMetadata(document, "beta.jojokanbao.cn")).toBe(true);
    expect(applyBetaMetadata(document, "BETA.JOJOKANBAO.CN")).toBe(true);

    const robots = document.head.querySelectorAll('meta[name="robots"]');
    expect(robots).toHaveLength(1);
    expect(robots[0]?.getAttribute("content")).toBe("noindex,nofollow,noarchive");
    expect(document.documentElement.dataset.releaseChannel).toBe("beta");
  });

  it("does not alter metadata on the stable hostname", () => {
    expect(applyBetaMetadata(document, "www.jojokanbao.cn", "stable")).toBe(false);
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.documentElement.dataset.releaseChannel).toBeUndefined();
  });

  it("shows the early-access mark only when the header is in beta mode", () => {
    const beta = render(
      <MemoryRouter>
        <AppHeader betaChannel />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Beta 提前体验版")).toBeTruthy();
    expect(screen.getByText("提前体验")).toBeTruthy();
    beta.unmount();

    render(
      <MemoryRouter>
        <AppHeader betaChannel={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("Beta 提前体验版")).toBeNull();
  });
});
