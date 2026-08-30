import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountMenu } from "../src/account/AccountMenu";
import { useAccountSessionStore } from "../src/account/session";

describe("AccountMenu", () => {
  beforeEach(() => {
    useAccountSessionStore.setState({ initialized: false, userId: null, displayName: null });
  });

  afterEach(() => cleanup());

  it("stays quiet until a persisted session has been checked", () => {
    render(<MemoryRouter><AccountMenu /></MemoryRouter>);

    expect(screen.queryByRole("link", { name: "登录" })).toBeNull();
    expect(screen.queryByRole("button", { name: /账号菜单/ })).toBeNull();

    act(() => useAccountSessionStore.setState({
      initialized: true,
      userId: "reader-1",
      displayName: "雪豹-TGH",
    }));

    expect(screen.getByRole("button", { name: /雪豹-TGH，账号菜单/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "雪豹-TGH，进入我的页面" }).getAttribute("href")).toBe("/account");
    expect(screen.queryByRole("link", { name: "登录" })).toBeNull();
  });

  it("only shows login after the session check confirms signed-out state", () => {
    render(<MemoryRouter><AccountMenu /></MemoryRouter>);

    expect(screen.queryByRole("link", { name: "登录" })).toBeNull();
    act(() => useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null }));
    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/account");
  });
});
