import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeScreen } from "./MeScreen";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
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
vi.mock("../account/auth", () => ({ MOBILE_ACCOUNT_CONFIGURED: false, useMobileAuthStore: () => ({ initialized: true, user: null, busy: false }) }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../components/ReaderCodeValue", () => ({ ReaderCodeValue: () => null }));
vi.mock("../components/PersonalInvitationPanel", () => ({ PersonalInvitationPanel: () => null }));
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
  expect(support.findAllByType("span").some((text) => text.props.children === "支持 JOJO 看报")).toBe(true);
  expect(support.parent).toBe(about.parent);
  await act(async () => support.props.onPress());
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("Support");
  await act(async () => about.props.onPress());
  expect(mocks.navigate).toHaveBeenLastCalledWith("Settings", { section: "about" });
});
