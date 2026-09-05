import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SpeechCapabilities, SpeechSource } from "@jojo/content";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { mobileSpeechClient } from "./speech";

export interface SpeechChapter { id: string; title: string; segments: string[] }
interface Bookmark { chapterId: string; fingerprint: string; part: number; seconds: number; provider: string; voice: string; rate: number }
export interface SpeechPlaybackProps {
  documentId: string; userId: string; title: string; chapterId: string;
  chapters: Array<{ id: string; title: string }>;
  loadChapter: (id: string) => Promise<SpeechChapter>;
}

export function useSpeechPlayback(props: SpeechPlaybackProps) {
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const [chapter, setChapter] = useState<SpeechChapter>();
  const [capabilities, setCapabilities] = useState<SpeechCapabilities>();
  const [voice, setVoice] = useState({ provider: "mimo", voice: "白桦" });
  const [part, setPart] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [durations, setDurations] = useState<Record<number, number>>({});
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
        }).catch(() => { if (mounted.current) { setError("音频定位失败，请重试"); setBusy(false); } });
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
      clearInterval(interval); listener.remove();
      functions.current.persist();
      // useAudioPlayer owns native release; do not release the same player twice.
      try { player.pause(); player.setActiveForLockScreen(false); } catch { /* hook may already have released */ }
    };
  }, [player, storageKey]);

  async function selectChapter(id: string, autoplay = false, saved?: Bookmark, choice = latest.current.voice, caps = latest.current.capabilities) {
    persist();
    const currentEpoch = ++epoch.current;
    operation.current++;
    session.current.abort(); session.current = new AbortController();
    sources.current.clear(); pending.current = undefined; activePart.current = undefined;
    ready.current = false; wanted.current = autoplay; player.pause(); setPlaying(false);
    mediaDeadline.current = 0; bookmark.current = undefined;
    setChapter(undefined); latest.current.chapter = undefined;
    setBusy(true); setError(""); setDurations({}); setVoice(choice);
    try {
      const loaded = await latest.current.props.loadChapter(id);
      const fingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(loaded.segments));
      if (!mounted.current || currentEpoch !== epoch.current) return;
      if (!loaded.segments.length) throw new Error("本章暂无可朗读的正文");
      const resume = saved?.fingerprint === fingerprint && Number.isInteger(saved.part) && saved.part >= 0 && saved.part < loaded.segments.length && Number.isFinite(saved.seconds);
      const index = resume ? saved.part : 0;
      const time = resume ? Math.max(0, saved.seconds) : 0;
      bookmark.current = { chapterId: id, fingerprint, part: index, seconds: time, ...choice, rate: latest.current.rate };
      latest.current = { ...latest.current, chapter: loaded, voice: choice, capabilities: caps, part: index, seconds: time };
      setChapter(loaded); setPart(index); setSeconds(time); setBusy(false); persist();
      const provider = caps?.providers.find((item) => item.id === choice.provider);
      if (caps?.cdnBase && provider?.cacheVersion) {
        void mobileSpeechClient.loadCachedSpeechDurations(loaded.segments, choice.voice, session.current.signal, {
          cdnBase: caps.cdnBase, cacheVersion: provider.cacheVersion, provider: choice.provider,
        }).then((known) => { if (mounted.current && currentEpoch === epoch.current) setDurations((current) => ({ ...known, ...current })); });
      }
      if (autoplay) await startPart(index, time);
    } catch (reason) {
      if (!mounted.current || currentEpoch !== epoch.current) return;
      wanted.current = false; setBusy(false); setError(reason instanceof Error ? reason.message : "正文读取失败");
    }
  }

  async function open() {
    if (latest.current.chapter && latest.current.capabilities) return;
    setBusy(true); setError("");
    const currentEpoch = epoch.current;
    try {
      const caps = await mobileSpeechClient.loadSpeechProviders(session.current.signal);
      const raw = await AsyncStorage.getItem(storageKey).catch(() => null);
      let saved: Bookmark | undefined;
      try { if (raw) saved = JSON.parse(raw) as Bookmark; } catch { /* corrupted local progress starts fresh */ }
      if (!mounted.current || currentEpoch !== epoch.current) return;
      const knownVoice = caps.providers.find((item) => item.id === saved?.provider)?.voices.some((item) => item.id === saved?.voice);
      const choice = knownVoice && saved ? { provider: saved.provider, voice: saved.voice } : {
        provider: caps.defaultProvider, voice: caps.defaultVoice || caps.providers.find((item) => item.id === caps.defaultProvider)?.voices[0]?.id || "白桦",
      };
      const speed = saved && Number.isFinite(saved.rate) && saved.rate >= 0.5 && saved.rate <= 2 ? saved.rate : 1;
      setRate(speed); latest.current.rate = speed;
      setCapabilities(caps);
      const id = saved && props.chapters.some((item) => item.id === saved.chapterId) ? saved.chapterId : props.chapterId;
      await selectChapter(id, false, saved, choice, caps);
    } catch (reason) { if (mounted.current) { setBusy(false); setError(reason instanceof Error ? reason.message : "听读暂时不可用"); } }
  }

  async function source(index: number): Promise<SpeechSource> {
    const current = latest.current;
    if (!current.capabilities?.cdnBase || !current.chapter?.segments[index]) throw new Error("请先配置云端音频存储");
    let promise = sources.current.get(index);
    if (!promise) {
      const provider = current.capabilities.providers.find((item) => item.id === current.voice.provider);
      promise = mobileSpeechClient.requestSpeech(current.chapter.segments[index]!, current.voice.voice, session.current.signal, {
        provider: current.voice.provider, cacheVersion: provider?.cacheVersion, cdnBase: current.capabilities.cdnBase,
      }).then((value) => { if (!("url" in value)) throw new Error("手机听读需要 CDN 音频，请检查服务端存储配置"); return value; });
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
      for (const key of sources.current.keys()) if (key !== index && key !== index + 1) sources.current.delete(key);
      if (latest.current.chapter?.segments[index + 1]) void source(index + 1).catch(() => undefined);
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
    if (ready.current && index === activePart.current) void player.seekTo(remaining).catch(() => setError("定位失败，请重试"));
    else void startPart(index, remaining, playing || wanted.current);
  }
  function toggle() {
    if (playing || (busy && wanted.current)) { halt(); return; }
    if (ready.current) { wanted.current = true; player.play(); }
    else if (chapter) void startPart(part, seconds);
    else void open();
  }
  function changeRate(value: number) {
    setRate(value); player.setPlaybackRate(value);
    if (bookmark.current) bookmark.current.rate = value;
    persist();
  }
  return { chapter, capabilities, voice, part, rate, playing, busy, error, timer, elapsed, duration,
    open, toggle, halt, seek, setTimer, changeRate, selectChapter,
    changeVoice: (provider: string, value: string) => chapter && selectChapter(chapter.id, playing, undefined, { provider, voice: value }),
  };
}
