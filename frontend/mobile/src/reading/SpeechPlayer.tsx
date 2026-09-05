import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import Slider from "@react-native-community/slider";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState, type ComponentProps } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobileAuthStore } from "../account/auth";
import { mobileTheme as theme } from "../theme/tokens";
import { useSpeechFlagStore } from "./featureFlag";
import { speechTime } from "./speech";
import { useSpeechPlayback, type SpeechPlaybackProps } from "./useSpeechPlayback";

type Props = Omit<SpeechPlaybackProps, "userId"> & {
  hidden?: boolean; bottom?: number; cover?: ImageSourcePropType; news?: boolean;
  onRead: (chapterId: string) => void; onBookshelf?: () => void; onShelf?: boolean; bookshelfBusy?: boolean;
};

export function NativeSpeechPlayer(props: Props) {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const flag = useSpeechFlagStore();
  const focused = useIsFocused();
  // Unmount the native player on logout, rollout rollback, or leaving this reader.
  if (!focused || !userId || flag.userId !== userId || !flag.enabled) return null;
  return <ActiveSpeechPlayer key={`${userId}:${props.documentId}`} {...props} userId={userId} />;
}

function ActiveSpeechPlayer(props: Props & { userId: string }) {
  const playback = useSpeechPlayback(props);
  const [opened, setOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<"timer" | "voice" | "rate" | "chapters" | null>(null);
  useEffect(() => { if (props.hidden) { setExpanded(false); setSheet(null); } }, [props.hidden]);
  const currentIndex = props.chapters.findIndex((item) => item.id === playback.chapter?.id);
  const voiceLabel = playback.capabilities?.providers.find((item) => item.id === playback.voice.provider)?.voices.find((item) => item.id === playback.voice.voice)?.label ?? playback.voice.voice;
  const background = theme.eInk ? theme.paper : "#f1ede6";
  function open() { setOpened(true); setExpanded(true); void playback.open(); }
  function chapterStep(step: number) { const next = props.chapters[currentIndex + step]; if (next) void playback.selectChapter(next.id, playback.playing); }
  function art(backdrop = false) { return props.cover ? <Image accessible={false} source={props.cover} resizeMode={backdrop ? "cover" : props.news ? "cover" : "contain"} blurRadius={backdrop && !theme.eInk ? 32 : 0} style={backdrop ? styles.backdropImage : [styles.cover, props.news && styles.newsCover]} /> : <View style={[styles.fallbackCover, { backgroundColor: theme.paper }]}><Text style={styles.fallbackTitle}>{props.title}</Text></View>; }
  return <>
    {!props.hidden && !expanded ? opened ? (
      <View style={[styles.mini, { bottom: props.bottom ?? 0, backgroundColor: background, borderColor: theme.rule }]}>
        {props.cover && !theme.eInk ? art(true) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="展开听读播放器" onPress={open} style={styles.miniTitle}>
          {props.cover ? <Image source={props.cover} style={styles.miniCover} /> : null}
          <View style={styles.flex}><Text numberOfLines={1} style={styles.miniHeading}>{playback.chapter?.title || props.title}</Text><Text style={styles.subtle}>{playback.busy ? "正在准备音频…" : `${voiceLabel} · ${speechTime(playback.elapsed)}`}</Text></View>
        </Pressable>
        <IconButton icon={playback.playing ? "pause" : "play"} label={playback.playing ? "暂停听读" : "继续听读"} onPress={playback.toggle} />
        <IconButton icon="close" label="关闭听读" onPress={() => { playback.halt(); setOpened(false); }} />
      </View>
    ) : <Pressable accessibilityRole="button" accessibilityLabel="打开听读播放器" onPress={open} style={[styles.launcher, { bottom: (props.bottom ?? 0) + 16, backgroundColor: theme.red }]}><Text style={styles.listen}>听</Text></Pressable> : null}
    <Modal visible={expanded && !props.hidden} animationType={theme.eInk ? "none" : "slide"} onRequestClose={() => sheet ? setSheet(null) : setExpanded(false)}>
      <SafeAreaView style={[styles.full, { backgroundColor: background }]}>
        {props.cover && !theme.eInk ? art(true) : null}
        <View style={styles.header}><IconButton icon="chevron-down" label="收起播放器" onPress={() => setExpanded(false)} /><Text style={styles.eyebrow}>{props.news ? "听新闻" : "听书"}</Text><View style={styles.icon} /></View>
        <ScrollView contentContainerStyle={styles.content}>
          {art()}
          <Text style={styles.bookName}>{props.title}</Text>
          <Text style={styles.chapterTitle}>{playback.chapter?.title || "准备听读"}</Text>
          <View style={styles.options}>
            <Option icon="timer-outline" label={playback.timer ? "已设定时" : "定时关闭"} onPress={() => setSheet("timer")} />
            <Option icon="person-outline" label={voiceLabel} onPress={() => setSheet("voice")} />
            <Option icon="speedometer-outline" label={`语速 ${playback.rate.toFixed(1)}×`} onPress={() => setSheet("rate")} />
            {props.onBookshelf ? <Option icon={props.onShelf ? "book" : "book-outline"} label={props.onShelf ? "已加入" : "加入书架"} disabled={props.bookshelfBusy} onPress={props.onBookshelf} /> : null}
          </View>
          <View style={styles.progress}>
            <SeekButton direction="back" onPress={() => playback.seek(playback.elapsed - 15)} />
            <Text style={styles.time}>{speechTime(playback.elapsed)}</Text>
            <Slider accessibilityLabel="本章播放进度" style={styles.slider} value={playback.elapsed} minimumValue={0} maximumValue={Math.max(1, playback.duration)} minimumTrackTintColor={theme.red} maximumTrackTintColor={theme.rule} thumbTintColor={theme.red} onSlidingComplete={playback.seek} disabled={!playback.chapter || playback.busy} />
            <Text style={styles.time}>{speechTime(playback.duration)}</Text>
            <SeekButton direction="forward" onPress={() => playback.seek(playback.elapsed + 15)} />
          </View>
          <Text accessibilityLiveRegion="polite" style={[styles.status, playback.error ? { color: theme.red } : null]}>{playback.error || (playback.busy ? "正在准备音频…" : playback.playing ? "" : "")}</Text>
          {playback.error ? <Pressable accessibilityRole="button" onPress={() => playback.chapter ? playback.toggle() : void playback.open()}><Text style={styles.retry}>重试</Text></Pressable> : null}
          <View style={styles.controls}>
            <Option icon="book-outline" label="原文" onPress={() => { setExpanded(false); props.onRead(playback.chapter?.id || props.chapterId); }} />
            <IconButton icon="play-skip-back" label="上一章" disabled={currentIndex <= 0} onPress={() => chapterStep(-1)} />
            <Pressable accessibilityRole="button" accessibilityLabel={playback.playing ? "暂停听读" : "开始听读"} onPress={playback.toggle} style={[styles.play, { backgroundColor: theme.red }]}><Ionicons name={playback.playing ? "pause" : "play"} size={30} color={theme.inverse} /></Pressable>
            <IconButton icon="play-skip-forward" label="下一章" disabled={currentIndex < 0 || currentIndex === props.chapters.length - 1} onPress={() => chapterStep(1)} />
            <Option icon="list-outline" label={props.news ? "目录" : `${props.chapters.length} 章`} onPress={() => setSheet("chapters")} />
          </View>
        </ScrollView>
        {sheet ? <View style={styles.sheetLayer}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭设置" style={styles.scrim} onPress={() => setSheet(null)} />
          <SafeAreaView edges={["bottom"]} style={[styles.sheet, { backgroundColor: theme.paper }]}>
            <View style={styles.header}><Text style={styles.sheetTitle}>{{ timer: "定时关闭", voice: "选择声音", rate: "语速设置", chapters: props.news ? "新闻目录" : "章节目录" }[sheet]}</Text><IconButton icon="close" label="关闭设置" onPress={() => setSheet(null)} /></View>
            <ScrollView>
              {sheet === "timer" ? <>{[0, 15, 30, 60, 90].map((minutes) => <Choice key={minutes} label={minutes ? `${minutes} 分钟` : "关闭"} selected={minutes === 0 && !playback.timer} onPress={() => { playback.setTimer(minutes ? Date.now() + minutes * 60000 : null); setSheet(null); }} />)}<Choice label="本章结束后关闭" selected={playback.timer === "chapter"} onPress={() => { playback.setTimer("chapter"); setSheet(null); }} /></> : null}
              {sheet === "voice" ? playback.capabilities?.providers.flatMap((provider) => provider.voices.map((voice) => <Choice key={`${provider.id}:${voice.id}`} label={voice.label} description={voice.description} selected={provider.id === playback.voice.provider && voice.id === playback.voice.voice} onPress={() => { void playback.changeVoice(provider.id, voice.id); setSheet(null); }} />)) : null}
              {sheet === "rate" ? [0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => <Choice key={value} label={`${value}×`} selected={playback.rate === value} onPress={() => { playback.changeRate(value); setSheet(null); }} />) : null}
              {sheet === "chapters" ? props.chapters.map((chapter) => <Choice key={chapter.id} label={chapter.title} selected={chapter.id === playback.chapter?.id} onPress={() => { void playback.selectChapter(chapter.id, true); setSheet(null); }} />) : null}
            </ScrollView>
          </SafeAreaView>
        </View> : null}
      </SafeAreaView>
    </Modal>
  </>;
}

type IconProps = { icon: ComponentProps<typeof Ionicons>["name"]; label: string; onPress: () => void; disabled?: boolean };
function IconButton({ icon, label, onPress, disabled }: IconProps) { return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.icon, disabled && { opacity: 0.3 }]}><Ionicons name={icon} size={24} color={theme.ink} /></Pressable>; }
function Option({ icon, label, onPress, disabled }: IconProps) { return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={styles.option}><Ionicons name={icon} size={23} color={theme.muted} /><Text numberOfLines={1} style={styles.optionLabel}>{label}</Text></Pressable>; }
function SeekButton({ direction, onPress }: { direction: "back" | "forward"; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={direction === "back" ? "后退15秒" : "前进15秒"} onPress={onPress} style={styles.seek}><MaterialCommunityIcons name={direction === "back" ? "rewind-15" : "fast-forward-15"} size={27} color={theme.muted} /></Pressable>; }
function Choice({ label, description, selected, onPress }: { label: string; description?: string; selected?: boolean; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityState={{ selected: Boolean(selected) }} onPress={onPress} style={styles.choice}><View style={styles.flex}><Text style={[styles.choiceLabel, selected && { color: theme.red }]}>{label}</Text>{description ? <Text style={styles.subtle}>{description}</Text> : null}</View>{selected ? <Ionicons name="checkmark" size={20} color={theme.red} /> : null}</Pressable>; }

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 }, full: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, minHeight: 56 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, eyebrow: { color: theme.muted, fontFamily: theme.sans, fontSize: 13 },
  content: { flexGrow: 1, alignItems: "center", paddingHorizontal: 16, paddingBottom: 32, paddingTop: 12, maxWidth: 620, width: "100%", alignSelf: "center" },
  cover: { width: 168, height: 234, marginVertical: 20 }, newsCover: { width: "90%", height: 210 },
  fallbackCover: { width: 168, minHeight: 200, borderWidth: 1, borderColor: theme.rule, padding: 22, marginVertical: 20, justifyContent: "center" }, fallbackTitle: { color: theme.red, fontFamily: theme.serif, fontSize: 24 },
  backdropImage: { ...StyleSheet.absoluteFillObject, opacity: 0.12 }, bookName: { color: theme.muted, fontFamily: theme.serif, fontSize: 12, marginTop: 6, textAlign: "center" },
  chapterTitle: { color: theme.ink, fontFamily: theme.serif, fontSize: 21, lineHeight: 32, marginTop: 10, textAlign: "center", paddingHorizontal: 10 },
  options: { flexDirection: "row", justifyContent: "space-evenly", width: "100%", marginTop: 32, marginBottom: 26 }, option: { minWidth: 48, flex: 1, height: 60, alignItems: "center", justifyContent: "center", gap: 7 }, optionLabel: { color: theme.muted, fontSize: 11, fontFamily: theme.sans },
  progress: { flexDirection: "row", alignItems: "center", width: "100%", gap: 3 }, seek: { width: 36, height: 44, alignItems: "center", justifyContent: "center" }, slider: { flex: 1, minWidth: 48, height: 40 }, time: { color: theme.muted, fontSize: 10, fontVariant: ["tabular-nums"] },
  status: { fontSize: 12, color: theme.muted, minHeight: 26, textAlign: "center" }, retry: { color: theme.red, padding: 8 }, controls: { flexDirection: "row", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 6 }, play: { width: 64, height: 64, alignItems: "center", justifyContent: "center" },
  launcher: { position: "absolute", zIndex: 5, right: 16, width: 44, height: 44, justifyContent: "center", alignItems: "center" }, listen: { color: theme.inverse, fontFamily: theme.serif, fontSize: 21 },
  mini: { position: "absolute", zIndex: 5, left: 0, right: 0, minHeight: 64, flexDirection: "row", alignItems: "center", borderTopWidth: 1, paddingHorizontal: 8, overflow: "hidden" }, miniTitle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, padding: 4 }, miniCover: { width: 34, height: 46 }, miniHeading: { color: theme.ink, fontFamily: theme.serif, fontSize: 13 }, subtle: { color: theme.muted, fontSize: 11, marginTop: 5 },
  sheetLayer: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.35)" }, sheet: { maxHeight: "72%", borderTopWidth: 1, borderColor: theme.rule }, sheetTitle: { fontSize: 19, color: theme.ink, fontFamily: theme.serif, marginLeft: 10 }, choice: { minHeight: 56, paddingHorizontal: 24, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.rule, flexDirection: "row", alignItems: "center" }, choiceLabel: { color: theme.ink, fontFamily: theme.sans, fontSize: 15 },
});
