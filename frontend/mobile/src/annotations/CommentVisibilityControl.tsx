import type { AnnotationVisibility } from "@jojo/content";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileTheme } from "../theme/tokens";

export interface CommentVisibilityControlProps {
  value: AnnotationVisibility;
  onChange: (value: AnnotationVisibility) => void;
  disabled?: boolean;
  theme: MobileTheme;
}

export function CommentVisibilityControl({ value, onChange, disabled = false, theme }: CommentVisibilityControlProps) {
  return <View accessibilityRole="radiogroup" accessibilityLabel="评论可见范围" style={styles.options}>
    {([{ value: "public", label: "公开" }, { value: "private", label: "仅自己可见" }] as const).map((option) => {
      const checked = value === option.value;
      return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label}
        accessibilityState={{ checked, disabled }} disabled={disabled}
        onPress={() => onChange(option.value)} style={[styles.option, { opacity: disabled ? .5 : 1 }]}>
        <View aria-hidden style={[styles.mark, { borderColor: checked ? theme.red : theme.muted, backgroundColor: checked ? theme.red : "transparent" }]} />
        <Text style={[styles.label, { color: checked ? theme.ink : theme.muted, fontFamily: theme.sans, fontWeight: checked ? "700" : "400" }]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  options: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 18, rowGap: 2 },
  option: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 7 },
  mark: { width: 8, height: 8, borderWidth: 1 },
  label: { fontSize: 12, lineHeight: 18 },
});
