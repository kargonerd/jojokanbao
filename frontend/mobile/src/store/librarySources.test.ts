import { expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ getItem: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { ...storage, setItem: vi.fn(async () => undefined), removeItem: vi.fn() } }));
import { useMobileStore } from "./mobileStore";

it("restores mandatory JOJO without losing saved reading preferences or community opt-in", async () => {
  await useMobileStore.persist.rehydrate();
  storage.getItem.mockResolvedValue(JSON.stringify({ state: { librarySources: ["community"], textScale: 1.12 }, version: 0 }));
  await useMobileStore.persist.rehydrate();
  expect(useMobileStore.getState().librarySources).toEqual(["jojo", "community"]);
  expect(useMobileStore.getState().textScale).toBe(1.12);
  useMobileStore.getState().setLibrarySourceEnabled("jojo", false);
  expect(useMobileStore.getState().librarySources).toEqual(["jojo", "community"]);
  useMobileStore.getState().setLibrarySourceEnabled("community", false);
  expect(useMobileStore.getState().librarySources).toEqual(["jojo"]);
});
