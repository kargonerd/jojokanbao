import { Pressable, Text, type StyleProp, type TextStyle } from "react-native";
import { useMobileAuthStore, useMobileReaderName } from "../account/auth";

export function ReaderCodeValue({ style }: { style: StyleProp<TextStyle> }) {
  const name = useMobileReaderName();
  const status = useMobileAuthStore((state) => state.profileStatus);
  const refresh = useMobileAuthStore((state) => state.refreshProfile);
  if (name) return <Text selectable style={style}>{name}</Text>;
  if (status === "loading" || status === "idle") return <Text style={style}>正在读取…</Text>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="重新读取读者代号" hitSlop={8} onPress={() => void refresh()}>
      <Text style={style}>暂未读取，点击重试</Text>
    </Pressable>
  );
}
