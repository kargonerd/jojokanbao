import { Platform } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";

export interface MobileTheme {
  red: string;
  redDark: string;
  ink: string;
  muted: string;
  rule: string;
  ruleDark: string;
  paper: string;
  paperSoft: string;
  canvas: string;
  inverse: string;
  serif: string;
  sans: string;
  shadowColor: string;
  eInk: boolean;
}

const serif = Platform.select({ ios: "Songti SC", android: "serif", default: "serif" })!;
const sans = Platform.select({ ios: "PingFang SC", android: "sans-serif", default: "sans-serif" })!;

export const editorialTheme: MobileTheme = {
  red: "#8b1a1a",
  redDark: "#651212",
  ink: "#202020",
  muted: "#68645f",
  rule: "#d8d4cf",
  ruleDark: "#202020",
  paper: "#ffffff",
  paperSoft: "#f7f5f1",
  canvas: "#f4f4f2",
  inverse: "#ffffff",
  serif,
  sans,
  shadowColor: "rgba(139,26,26,.14)",
  eInk: false,
};

export const eInkTheme: MobileTheme = {
  ...editorialTheme,
  red: "#000000",
  redDark: "#000000",
  ink: "#000000",
  muted: "#333333",
  rule: "#777777",
  ruleDark: "#000000",
  paperSoft: "#ffffff",
  canvas: "#ffffff",
  inverse: "#ffffff",
  shadowColor: "transparent",
  eInk: true,
};

export const mobileTheme: MobileTheme = IS_EINK_RELEASE ? eInkTheme : editorialTheme;
