import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LibrarySettingsPage } from "../src/library/LibrarySettingsPage";
import { useLibraryPreferencesStore, useLibraryVisibility } from "../src/library/preferencesStore";

beforeEach(() => { localStorage.clear(); useLibraryPreferencesStore.setState({ enabledSources: ["jojo"] }); });
afterEach(cleanup);
function Library({ signedIn }: { signedIn: boolean }) {
  const visible = useLibraryVisibility(signedIn);
  return <>{visible({}) && <p>JOJO 示例书</p>}{visible({ librarySource: "community" }) && <p>分享示例书</p>}</>;
}
it("requires both login and explicit opt-in, updates immediately and persists the choice", async () => {
  const view = render(<MemoryRouter><LibrarySettingsPage /><Library signedIn={false} /></MemoryRouter>);
  expect(screen.getByRole("switch", { name: "共享书库" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("switch", { name: "共享书库" }));
  expect(screen.queryByText("分享示例书")).toBeNull();
  view.rerender(<MemoryRouter><LibrarySettingsPage /><Library signedIn /></MemoryRouter>);
  expect(screen.getByText("分享示例书")).toBeTruthy();
  await act(async () => { await useLibraryPreferencesStore.persist.rehydrate(); });
  expect(useLibraryPreferencesStore.getState().enabledSources).toContain("community");
  fireEvent.click(screen.getByRole("switch", { name: "共享书库" }));
  expect(screen.queryByText("分享示例书")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("switch", { name: "JOJO书库" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "JOJO书库" }));
  expect(screen.getByText("JOJO 示例书")).toBeTruthy();
});

it("restores JOJO from saved disabled preferences and refuses to turn it off", async () => {
  localStorage.setItem("jojo-library-preferences", JSON.stringify({ state: { enabledSources: ["community"] }, version: 0 }));
  await useLibraryPreferencesStore.persist.rehydrate();
  expect(useLibraryPreferencesStore.getState().enabledSources).toEqual(["jojo", "community"]);
  useLibraryPreferencesStore.getState().setSourceEnabled("jojo", false);
  expect(useLibraryPreferencesStore.getState().enabledSources).toEqual(["jojo", "community"]);
});
