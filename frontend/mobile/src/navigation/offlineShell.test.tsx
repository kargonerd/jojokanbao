import { createJojoAuthStore, type JojoAuthClient, type JojoAuthStore } from "@jojo/auth";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReaderIdentityCache } from "../account/readerIdentity";
import { MainTabs } from "../../App";
import { ScreenHeader } from "../components/ScreenHeader";

const mocks = vi.hoisted(() => ({ auth: undefined as unknown as JojoAuthStore,
  identity: undefined as unknown as ReturnType<typeof createReaderIdentityCache> }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => mocks.auth(select),
  useMobileReaderName: () => mocks.identity.useIdentityStore((state) => state.displayName), startMobileAuthSync: () => () => undefined }));
vi.mock("react-native", () => ({ Image: "img", Pressable: "button", Text: "span", View: "div",
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", () => ({ DefaultTheme: {}, NavigationContainer: "navigation", useNavigation: () => ({ navigate() {} }) }));
vi.mock("@react-navigation/bottom-tabs", () => ({ createBottomTabNavigator: () => ({ Navigator: "section", Screen: "nav" }) }));
vi.mock("@react-navigation/native-stack", () => ({ createNativeStackNavigator: () => ({ Navigator: "stack", Screen: "screen", Group: "group" }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: "safe", useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-status-bar", () => ({ StatusBar: "status" }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn(), selectionHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ hapticsEnabled: false }) }));
vi.mock("../reading/featureFlag", () => ({ startSpeechFlagSync: () => () => undefined }));
vi.mock("../components/AppUpdatePrompt", () => ({ AppUpdatePrompt: () => null }));
vi.mock("../screens/HomeScreen", () => ({ HomeScreen: () => null }));
vi.mock("../screens/BookDetailsScreen", () => ({ BookDetailsScreen: () => null }));
vi.mock("../screens/BookReaderScreen", () => ({ BookReaderScreen: () => null }));
vi.mock("../screens/LibraryScreen", () => ({ LibraryScreen: () => null }));
vi.mock("../screens/ReaderScreen", () => ({ ReaderScreen: () => null }));
vi.mock("../screens/SearchScreen", () => ({ SearchScreen: () => null }));
vi.mock("../screens/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("../screens/OpenSourceLicensesScreen", () => ({ OpenSourceLicensesScreen: () => null }));
vi.mock("../screens/MeScreen", () => ({ MeScreen: () => null }));
vi.mock("../screens/AccountSecurityScreen", () => ({ AccountSecurityScreen: () => null }));
vi.mock("../screens/AiScreen", () => ({ AiScreen: () => null }));
vi.mock("../screens/TimesScreen", () => ({ TimesScreen: () => null }));
vi.mock("../screens/TimesDetailScreen", () => ({ TimesDetailScreen: () => null }));
vi.mock("../screens/NotificationsScreen", () => ({ NotificationsScreen: () => null }));
vi.mock("../screens/BookshelfScreen", () => ({ BookshelfScreen: () => null }));

let view: ReactTestRenderer;
let stopAuth: (() => void) | undefined;
let stopIdentity: (() => void) | undefined;
afterEach(async () => { await act(async () => view?.unmount()); stopAuth?.(); stopIdentity?.(); });

describe("offline native navigation and reader name", () => {
  it("keeps five tabs and the nickname through offline initialization, and clears them on a real logout", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const session = { user: { id: "reader" }, access_token: "expired", refresh_token: "refresh" };
    const onAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } }));
    const query = { abortSignal() {}, maybeSingle: vi.fn().mockRejectedValue(new Error("offline")) };
    const client = { auth: { getSession: vi.fn().mockRejectedValue(new Error("offline")), onAuthStateChange },
      from: () => ({ select: () => ({ eq: () => query }) }) } as unknown as JojoAuthClient;
    let finishSession!: (value: unknown) => void;
    const readPersistedSession = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finishSession = resolve; })).mockResolvedValue(session);
    const controller = createJojoAuthStore(client, { readPersistedSession });
    mocks.auth = controller.useAuthStore;
    const storage = { getItem: vi.fn().mockResolvedValue(JSON.stringify({ userId: "reader", displayName: "雪豹-TGH" })),
      setItem: vi.fn().mockResolvedValue(undefined), removeItem: vi.fn().mockResolvedValue(undefined) };
    mocks.identity = createReaderIdentityCache(mocks.auth, storage);
    stopIdentity = mocks.identity.start(); stopAuth = controller.startAuthSync();
    await act(async () => { view = create(<><MainTabs /><ScreenHeader title="首页" showAccount onBack={() => undefined} /></>); });
    expect(storage.removeItem).not.toHaveBeenCalled();
    await act(async () => finishSession(session));
    expect(view.root.findAllByType("nav").map((node) => node.props.name)).toEqual(["Today", "Library", "Search", "AI", "Times"]);
    expect(view.root.findAllByType("span").some((node) => node.props.children === "雪豹-TGH")).toBe(true);
    const emit = vi.mocked(client.auth.onAuthStateChange).mock.calls[0]![0];
    await act(async () => { emit("INITIAL_SESSION", null); });
    expect(view.root.findAllByType("nav")).toHaveLength(5);
    expect(view.root.findAllByType("span").some((node) => node.props.children === "雪豹-TGH")).toBe(true);
    await act(async () => { emit("SIGNED_OUT", null); });
    expect(view.root.findAllByType("nav")).toHaveLength(3);
    expect(view.root.findAllByType("span").some((node) => node.props.children === "登录")).toBe(true);
  });
});
