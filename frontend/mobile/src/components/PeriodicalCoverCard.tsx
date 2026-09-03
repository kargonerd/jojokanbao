import type { ArchivePublicationName, ArchivePublicationSummary } from "@jojo/content";
import { memo } from "react";
import { Image, Pressable, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme } from "../theme/tokens";

export const publicationImages: Record<ArchivePublicationName, ImageSourcePropType> = {
  rmrb: require("../../../packages/content/assets/periodicals/people-daily-brand.jpg"),
  ckxx: require("../../../packages/content/assets/periodicals/reference-news-brand.jpg"),
  hq: require("../../../packages/content/assets/periodicals/red-flag-brand.jpg"),
  rmhb: require("../../../packages/content/assets/periodicals/china-pictorial-brand.jpg"),
  sjzs: require("../../../packages/content/assets/periodicals/world-affairs-brand.jpg"),
};

export const PeriodicalCoverCard = memo(function PeriodicalCoverCard({
  publication,
  onOpen,
  onPickDate,
}: {
  publication: ArchivePublicationSummary;
  onOpen: () => void;
  onPickDate?: () => void;
}) {
  const theme = mobileTheme;
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={`打开${publication.title}`} onPress={onOpen} style={({ pressed }) => [pressed && !IS_EINK_RELEASE && styles.pressed]}>
        <View style={[styles.cover, IS_EINK_RELEASE && styles.eInkCover, { borderColor: theme.rule }]}>
          <Image
            source={publicationImages[publication.id]}
            resizeMode="cover"
            style={styles.image}
            accessibilityIgnoresInvertColors
          />
        </View>
        <Text numberOfLines={1} style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>{publication.title}</Text>
        <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted, fontFamily: theme.sans }]}>{publication.kind} · {publication.years}</Text>
      </Pressable>
      {onPickDate ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`选择${publication.title}日期`} onPress={onPickDate} hitSlop={6}>
          <Text style={[styles.date, { color: theme.red, fontFamily: theme.sans }]}>选择日期</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.82, transform: [{ translateY: -2 }] },
  cover: { width: "100%", aspectRatio: 0.7, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  eInkCover: { filter: "grayscale(1) contrast(1.25)" },
  title: { marginTop: 8, fontSize: 13, lineHeight: 18, fontWeight: "900" },
  subtitle: { marginTop: 2, fontSize: 9 },
  date: { marginTop: 5, fontSize: 10, fontWeight: "800" },
});
