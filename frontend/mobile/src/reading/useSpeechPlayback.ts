import AsyncStorage from "@react-native-async-storage/async-storage";
import { speechFromReadingPosition, type SpeechReadingPosition } from "@jojo/content";
import type { SpeechCapabilities, SpeechSource } from "@jojo/content/speech";
import { logicalSpeechVoice, speechCueAt, type SpeechCue } from "@jojo/content/speech";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { mobileSpeechClient } from "./speech";
import { AudioPrefetch } from "./audioPrefetch";

export interface SpeechChapter { id: string; title: string; segments: string[] }
interface Bookmark { chapterId: string; fingerprint: string; part: number; seconds: number; provider: string; voice: string; rate: number }
export interface SpeechPlaybackProps {
  documentId: string; userId: string; title: string; chapterId: string;
  chapters: Array<{ id: string; title: string }>;
  loadChapter: (id: string) => Promise<SpeechChapter>;
  getReadingPosition?: () => Promise<SpeechReadingPosition | null>;
}

export function useSpeechPlayback(props: SpeechPlaybackProps) {
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const [chapter, setChapter] = useState<SpeechChapter>();
  const [capabilities, setCapabilities] = useState<SpeechCapabilities>();
  const [voice, setVoice] = useState({ provider: "auto", voice: "male" });
  const [part, setPart] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [durations, setDurations] = useState<Record<number, number>>({});
  const [cues, setCues] = useState<Record<number, SpeechCue[]>>({});
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [timer, setTimer] = useState<number | "chapter" | null>(null);
  const storageKey = `jojo-listening-v1:${props.userId}:${props.documentId}`;
  const latest = useRef({ props, chapter, capabilities, voice, part, seconds, rate, timer });
  latest.current = { props, chapter, capabilities, voice, part, seconds, rate, timer };
  const mounted = useRef(true);
  const session = useRef(new AbortController());
  const epoch = useRef(0);
  const operation = useRef(0);
  const wanted = useRef(false);
  const ready = useRef(false);
  const bookmark = useRef<Bookmark | undefined>(undefined);
  const sources = useRef(new Map<number, Promise<SpeechSource>>());
  const prefetch = useRef(new AudioPrefetch());
  const prefetchedUrls = useRef(new Map<number, string>());
  const pending = useRef<{ seconds: number; operation: number } | undefined>(undefined);
  const activePart = useRef<number | undefined>(undefined);
  const finishHandled = useRef(false);
  const mediaDeadline = useRef(0);
  const functions = useRef({ next: () => {}, persist: () => {} });

  function persist() {
    if (bookmark.current) void AsyncStorage.setItem(storageKey, JSON.stringify(bookmark.current)).catch(() => undefined);
  }
  functions.current.persist = persist;

  function halt() {
    wanted.current = false;
    player.pause();
    setPlaying(false);
    persist();
  }

  function close() {
    wanted.current = false;
    epoch.current++; operation.current++;
    session.current.abort(); session.current = new AbortController();
    sources.current.clear(); pending.current = undefined; activePart.current = undefined;
    prefetch.current.retain();
    prefetchedUrls.current.clear();
    ready.current = false; mediaDeadline.current = 0;
    // Android's Expo Audio replace() requires a non-null source. Keep the
    // paused player for reopening; useAudioPlayer owns release on unmount.
    try { player.pause(); } catch { /* navigation may already have released it */ }
    try { player.setActiveForLockScreen(false); } catch { /* already released */ }
    persist();
    setPlaying(false); setBusy(false); setTimer(null); setError("");
    if (latest.current.props.getReadingPosition) { setChapter(undefined); latest.current.chapter = undefined; }
  }

  useEffect(() => {
    mounted.current = true;
    const listener = player.addListener("playbackStatusUpdate", (status) => {
      if (!mounted.current || activePart.current === undefined) return;
      if (status.isLoaded && pending.current) {
        const load = pending.current;
        pending.current = undefined;
        void player.seekTo(Math.min(load.seconds, Math.max(0, status.duration - 0.05))).then(() => {
          if (!mounted.current || load.operation !== operation.current) return;
          ready.current = true;
          mediaDeadline.current = 0;
          setBusy(false);
          player.setPlaybackRate(latest.current.rate);
          if (wanted.current) player.play();
        }).catch(() => { if (mounted.current && load.operation === operation.current) { setError("音频定位失败，请重试"); setBusy(false); } });
      }
      if (!ready.current) return;
      const time = Number.isFinite(status.currentTime) ? status.currentTime : 0;
      setSeconds(time);
      setPlaying(status.playing);
      if (bookmark.current) bookmark.current.seconds = time;
      if (status.duration > 0) setDurations((known) => known[activePart.current!] === status.duration ? known : { ...known, [activePart.current!]: status.duration });
      if (status.didJustFinish && !finishHandled.current) {
        finishHandled.current = true;
        functions.current.next();
      }
    });
    let ticks = 0;
    const interval = setInterval(() => {
      if (++ticks % 5 === 0) functions.current.persist();
      if (mediaDeadline.current && Date.now() >= mediaDeadline.current) {
        mediaDeadline.current = 0; pending.current = undefined; operation.current++;
        wanted.current = false; player.pause(); setPlaying(false); setBusy(false); setError("音频加载超时，请重试");
      }
      const deadline = latest.current.timer;
      if (typeof deadline === "number" && Date.now() >= deadline) {
        wanted.current = false; player.pause(); setPlaying(false); setTimer(null);
      }
    }, 1000);
    return () => {
      mounted.current = false;
      epoch.current++; operation.current++;
      session.current.abort();
      prefetch.current.retain();
      clearInterval(interval); listener.remove();
      functions.current.persist();
      // useAudioPlayer owns native release; do not release the same player twice.
      try { player.pause(); player.setActiveForLockScreen(false); } catch { /* hook may already have released */ }
    };
  }, [player, storageKey]);

  async function selectChapter(id: string, autoplay = false, saved?: Bookmark, choice = latest.current.voice, caps = latest.current.capabilities, position?: SpeechReadingPosition | null, retainedChapter?: SpeechChapter) {
    persist();
    const currentEpoch = ++epoch.current;
    operation.current++;
    session.current.abort(); session.current = new AbortController();
    sources.current.clear(); pending.current = undefined; activePart.current = undefined;
    prefetch.current.retain();
    prefetchedUrls.current.clear();
    ready.current = false; wanted.current = autoplay; player.pause(); setPlaying(false);
    mediaDeadline.current = 0; bookmark.current = undefined;
    setChapter(undefined); latest.current.chapter = undefined;
    setBusy(true); setError(""); setDurations({}); setCues({}); setVoice(choice);
    try {
      const original = retainedChapter ?? await latest.current.props.loadChapter(id);
      const entry = speechFromReadingPosition(original.segments, position);
      const loaded = { ...original, segments: entry.segments };
      const fingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(loaded.segments));
      if (!mounted.current || currentEpoch !== epoch.current) return;
      if (!loaded.segments.length) throw new Error("本章暂无可朗读的正文");
      const resume = saved?.fingerprint === fingerprint && Number.isInteger(saved.part) && saved.part >= 0 && saved.part < loaded.segments.length && Number.isFinite(saved.seconds);
      const index = resume ? saved.part : entry.index;
      const time = resume ? Math.max(0, saved.seconds) : 0;
      bookmark.current = { chapterId: id, fingerprint, part: index, seconds: time, ...choice, rate: latest.current.rate };
      latest.current = { ...latest.current, chapter: loaded, voice: choice, capabilities: caps, part: index, seconds: time };
      setChapter(loaded); setPart(index); setSeconds(time); setBusy(false); persist();
      const provider = caps?.providers.find((item) => item.id === choice.provider);
      if (caps?.cdnBase && provider?.cacheVersion) {
        void mobileSpeechClient.loadCachedSpeechDurations(loaded.segments, choice.voice, session.current.signal, {
          cdnBase: caps.cdnBase, cacheVersion: provider.cacheVersion, provider: choice.provider,
          scope: latest.current.props.documentId.startsWith("news:") ? "news" : "book",
        }).then((known) => { if (mounted.current && currentEpoch === epoch.current) setDurations((current) => ({ ...known, ...current })); });
      }
      // Pausing/closing while the chapter loads must cancel its captured autoplay.
      if (autoplay && wanted.current) await startPart(index, time);
    } catch (reason) {
      if (!mounted.current || currentEpoch !== epoch.current) return;
      wanted.current = false; setBusy(false); setError(reason instanceof Error ? reason.message : "正文读取失败");
    }
  }

  async function open() {
    if (latest.current.chapter && latest.current.capabilities) return;
    setBusy(true); setError("");
    const currentEpoch = ++epoch.current;
    const reading = latest.current.props;
    try {
      const position = await reading.getReadingPosition?.();
      if (!mounted.current || currentEpoch !== epoch.current) return;
      const caps = await mobileSpeechClient.loadSpeechProviders(session.current.signal);
      const raw = await AsyncStorage.getItem(storageKey).catch(() => null);
      let saved: Bookmark | undefined;
      try { if (raw) saved = JSON.parse(raw) as Bookmark; } catch { /* corrupted local progress starts fresh */ }
      if (!mounted.current || currentEpoch !== epoch.current) return;
      const knownVoice = caps.providers.find((item) => item.id === saved?.provider)?.voices.some((item) => item.id === saved?.voice);
      const choice = caps.defaultProvider === "auto" ? { provider: "auto", voice: logicalSpeechVoice(saved?.voice) } : knownVoice && saved ? { provider: saved.provider, voice: saved.voice } : {
        provider: caps.defaultProvider, voice: caps.defaultVoice || caps.providers.find((item) => item.id === caps.defaultProvider)?.voices[0]?.id || "白桦",
      };
      const speed = saved && Number.isFinite(saved.rate) && saved.rate >= 0.5 && saved.rate <= 2 ? saved.rate : 1;
      setRate(speed); latest.current.rate = speed;
      setCapabilities(caps);
      const id = !reading.getReadingPosition && saved && reading.chapters.some((item) => item.id === saved.chapterId) ? saved.chapterId : reading.chapterId;
      await selectChapter(id, false, reading.getReadingPosition ? undefined : saved, choice, caps, position);
    } catch (reason) { if (mounted.current && currentEpoch === epoch.current) { setBusy(false); setError(reason instanceof Error ? reason.message : "听读暂时不可用"); } }
  }

  async function source(index: number): Promise<SpeechSource> {
    const current = latest.current;
    if (!current.capabilities?.cdnBase || !current.chapter?.segments[index]) throw new Error("请先配置云端音频存储");
    let promise = sources.current.get(index);
    if (!promise) {
      const provider = current.capabilities.providers.find((item) => item.id === current.voice.provider);
      const signal = session.current.signal;
      promise = mobileSpeechClient.requestSpeech(current.chapter.segments[index]!, current.voice.voice, signal, {
        provider: current.voice.provider, cacheVersion: provider?.cacheVersion, cdnBase: current.capabilities.cdnBase,
        scope: current.props.documentId.startsWith("news:") ? "news" : "book",
      }).then((value) => {
        if (!("url" in value)) throw new Error("手机听读需要 CDN 音频，请检查服务端存储配置");
        void mobileSpeechClient.loadSpeechCues(value, current.chapter!.segments[index]!, signal).then((timing) => {
          if (timing && mounted.current && !signal.aborted) setCues((known) => ({ ...known, [index]: timing }));
        });
        return value;
      });
      sources.current.set(index, promise);
      void promise.catch(() => { if (sources.current.get(index) === promise) sources.current.delete(index); });
    }
    return promise;
  }

  async function startPart(index: number, time = 0, play = true) {
    const request = ++operation.current;
    wanted.current = play; ready.current = false; activePart.current = undefined; pending.current = undefined;
    mediaDeadline.current = 0;
    player.pause(); setBusy(true); setError("");
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "doNotMix" });
      const audio = await source(index);
      if (!mounted.current || request !== operation.current) return;
      finishHandled.current = false;
      player.replace({ uri: audio.url });
      mediaDeadline.current = Date.now() + 30000;
      activePart.current = index;
      pending.current = { seconds: time, operation: request };
      setPart(index); setSeconds(time); setDurations((known) => ({ ...known, [index]: audio.duration }));
      if (bookmark.current) { bookmark.current.part = index; bookmark.current.seconds = time; }
      player.setActiveForLockScreen(true, { title: latest.current.chapter?.title, artist: props.title });
      for (const key of sources.current.keys()) if (key < index || key > index + 2) sources.current.delete(key);
      for (const key of prefetchedUrls.current.keys()) if (key < index || key > index + 2) prefetchedUrls.current.delete(key);
      const nextUrls = [...prefetchedUrls.current].filter(([key]) => key > index).map(([, url]) => url);
      // Keep an already buffered current source until replace() consumes it.
      prefetch.current.retain(audio.url, nextUrls);
      for (const next of [index + 1, index + 2]) {
        if (!latest.current.chapter?.segments[next]) continue;
        void source(next).then((value) => {
          if (!mounted.current || request !== operation.current) return;
          prefetchedUrls.current.set(next, value.url);
          if (!nextUrls.includes(value.url)) nextUrls.push(value.url);
          prefetch.current.retain(audio.url, nextUrls);
        }).catch(() => undefined);
      }
    } catch (reason) {
      if (!mounted.current || request !== operation.current) return;
      wanted.current = false; setPlaying(false); setBusy(false); setError(reason instanceof Error ? reason.message : "播放失败，请重试");
    }
  }

  functions.current.next = () => {
    const current = latest.current;
    if (current.chapter?.segments[(activePart.current ?? 0) + 1]) { void startPart((activePart.current ?? 0) + 1); return; }
    if (current.timer === "chapter") { setTimer(null); halt(); return; }
    const index = props.chapters.findIndex((item) => item.id === current.chapter?.id);
    const next = props.chapters[index + 1];
    if (next) void selectChapter(next.id, true);
    else halt();
  };

  const lengths = chapter?.segments.map((text, index) => durations[index] ?? Math.max(1, text.length / 4.3)) ?? [];
  const elapsed = lengths.slice(0, part).reduce((sum, value) => sum + value, 0) + seconds;
  const duration = lengths.reduce((sum, value) => sum + value, 0);
  function seek(value: number) {
    let remaining = Math.max(0, Math.min(duration - 0.1, value));
    let index = 0;
    while (index < lengths.length - 1 && remaining >= lengths[index]!) { remaining -= lengths[index]!; index++; }
    if (ready.current && index === activePart.current) {
      finishHandled.current = false;
      void player.seekTo(remaining).catch(() => setError("定位失败，请重试"));
    }
    else void startPart(index, remaining, playing || wanted.current);
  }
  function toggle() {
    if (playing || (busy && wanted.current)) { halt(); return; }
    // Native players remain at EOF after finishing; replay the chapter like Web.
    if (ready.current && finishHandled.current) void startPart(0);
    else if (ready.current) { wanted.current = true; player.play(); }
    else if (chapter) void startPart(part, seconds);
    else void open();
  }
  function changeRate(value: number) {
    setRate(value); player.setPlaybackRate(value);
    if (bookmark.current) bookmark.current.rate = value;
    persist();
  }
  return { chapter, capabilities, voice, part, rate, playing, busy, error, timer, elapsed, duration, cue: speechCueAt(cues[part], seconds),
    open, toggle, halt, close, seek, setTimer, changeRate, selectChapter,
    changeVoice: (provider: string, value: string) => chapter && selectChapter(chapter.id, playing, bookmark.current, { provider, voice: value }, capabilities, undefined, chapter),
  };
}
