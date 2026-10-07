import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeScreen } from "./MeScreen";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
const accountState = vi.hoisted(() => ({
  initialized: true,
  user: null as { id: string; email: string } | null,
  busy: false,
  signupInvitationRequired: false,
  refreshSignupPolicy: vi.fn(() => Promise.resolve()),
}));
const invitationPanel = vi.hoisted(() => vi.fn((_props?: { userId?: string }) => null));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", View: "div", ScrollView: "main", TextInput: "input",
  Modal: () => null, Keyboard: {}, Easing: {},
  Animated: { View: "div", Value: class { interpolate() { return 0; } } },
  useWindowDimensions: () => ({ width: 360, height: 740 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate, goBack: vi.fn() }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "section" }));
vi.mock("../account/auth", () => ({ MOBILE_ACCOUNT_CONFIGURED: false, useMobileAuthStore: () => accountState }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../components/ReaderCodeValue", () => ({ ReaderCodeValue: () => null }));
vi.mock("../components/PersonalInvitationPanel", () => ({ PersonalInvitationPanel: invitationPanel }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));

let view: ReactTestRenderer;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  await act(async () => { view = create(<MeScreen />); });
});
afterEach(async () => { await act(async () => view.unmount()); });

it("opens support directly from the settings row immediately above about", async () => {
  const rows = view.root.findAllByType("button");
  const aboutIndex = rows.findIndex((row) => row.findAllByType("span").some((text) => text.props.children === "关于"));
  expect(aboutIndex).toBeGreaterThan(0);
  const support = rows[aboutIndex - 1]!;
  const about = rows[aboutIndex]!;
  expect(support.findAllByType("span").some((text) => text.props.children === "支持我们")).toBe(true);
  expect(support.parent).toBe(about.parent);
  await act(async () => support.props.onPress());
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("Support");
  await act(async () => about.props.onPress());
  expect(mocks.navigate).toHaveBeenLastCalledWith("Settings", { section: "about" });
});

it("renders the personal invitation panel only while signup requires invitations", async () => {
  accountState.user = { id: "reader-1", email: "reader@example.com" };

  await act(async () => { view.unmount(); view = create(<MeScreen />); });
  expect(invitationPanel).not.toHaveBeenCalled();

  accountState.signupInvitationRequired = true;
  await act(async () => { view.unmount(); view = create(<MeScreen />); });
  expect(invitationPanel.mock.calls.some((call) => call[0]?.userId === "reader-1")).toBe(true);
});
