import { memo, useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { loadMobileBookCover, type MobileBook } from "../lib/books";
import { mobileTheme } from "../theme/tokens";

const coverTones = [
  { background: "#8b1a1a", foreground: "#ffffff" },
  { background: "#302e2b", foreground: "#ffffff" },
  { background: "#d8cdb7", foreground: "#4c2720" },
  { background: "#7d382f", foreground: "#fffaf2" },
  { background: "#a9aaa5", foreground: "#202020" },
] as const;

function toneFor(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return coverTones[hash % coverTones.length]!;
}

export const BookCoverCard = memo(function BookCoverCard({
  book,
  itemKey,
  title,
  subtitle,
  layout = "grid",
  onPress,
}: {
  book: MobileBook;
  itemKey?: string;
  title: string;
  subtitle?: string;
  layout?: "grid" | "featured";
  onPress: () => void;
}) {
  const theme = mobileTheme;
  const [imageUri, setImageUri] = useState("");
  const featured = layout === "featured";
  const tone = IS_EINK_RELEASE ? { background: theme.paper, foreground: theme.ink } : toneFor(`${book.datasetId}:${itemKey ?? ""}`);

  useEffect(() => {
    let active = true;
    setImageUri("");
    void loadMobileBookCover(book, itemKey)
      .then((uri) => { if (active && uri) setImageUri(uri); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [book, itemKey]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}${subtitle ? `，${subtitle}` : ""}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, featured && styles.featuredCard, pressed && !IS_EINK_RELEASE && styles.pressed]}
    >
      <View style={[styles.cover, featured && styles.featuredCover, IS_EINK_RELEASE && styles.eInkCover, { borderColor: theme.rule, backgroundColor: tone.background }]}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} resizeMode="cover" style={styles.image} accessibilityIgnoresInvertColors />
        ) : (
          <Text numberOfLines={6} style={[styles.fallbackTitle, { color: tone.foreground, fontFamily: theme.serif }]}>{title}</Text>
        )}
      </View>
      <View style={featured ? styles.featuredCopy : undefined}>
        <Text numberOfLines={featured ? 3 : 2} style={[styles.title, featured && styles.featuredTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[styles.subtitle, featured && styles.featuredSubtitle, { color: featured ? theme.red : theme.muted, borderColor: theme.red, fontFamily: theme.sans }]}>{subtitle}</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0 },
  featuredCard: { maxWidth: 860, flexDirection: "row", alignItems: "center" },
  pressed: { opacity: 0.82, transform: [{ translateY: -2 }] },
  cover: { width: "100%", aspectRatio: 0.7, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", alignItems: "center", justifyContent: "center", padding: 12 },
  featuredCover: { width: 220, flexShrink: 0 },
  eInkCover: { filter: "grayscale(1) contrast(1.15)" },
  image: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  fallbackTitle: { fontSize: 15, lineHeight: 24, fontWeight: "900", textAlign: "center" },
  title: { marginTop: 8, minHeight: 38, fontSize: 13, lineHeight: 19, fontWeight: "900" },
  subtitle: { marginTop: 2, fontSize: 10 },
  featuredCopy: { flex: 1, minWidth: 0, paddingHorizontal: 38 },
  featuredTitle: { marginTop: 0, minHeight: 0, fontSize: 27, lineHeight: 39 },
  featuredSubtitle: { alignSelf: "flex-start", marginTop: 24, borderWidth: 1, paddingHorizontal: 22, paddingVertical: 11, fontWeight: "900" },
});
