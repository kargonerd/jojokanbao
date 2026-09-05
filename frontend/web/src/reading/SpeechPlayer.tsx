import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Backward15Seconds, Forward15Seconds, Book, BookStack, Check, DashboardSpeed, Headset, List, NavArrowDown, PauseSolid, PlaySolid, SkipNextSolid, SkipPrevSolid, Timer, User, Xmark } from "iconoir-react";
import { ReadingBookshelfContext } from "./ReadingBookshelfContext";
import { DEFAULT_SPEECH_PROVIDERS, loadCachedSpeechDurations, loadSpeechProviders, requestSpeech, SPEECH_VOICES, type SpeechProvider, type SpeechVoice } from "./speech";
import "./SpeechPlayer.css";
import { readSpeechProgress, saveSpeechProgress, speechFingerprint } from "./speechProgress";
import { useAccountSessionStore } from "../account/session";
import { useFeatureFlag } from "../featureFlags";

type PlayerState = "idle" | "loading" | "playing" | "paused" | "complete" | "error";
type SettingPanel = "sleep" | "voice" | "speed";

const SPEEDS = [0.8, 1, 1.25, 1.5, 2] as const;
const SLEEP_TIMERS = [0, 15, 30, 60] as const;
const VOICE_STORAGE_KEY = "jojo-reader-speech-voice";
const SPEED_STORAGE_KEY = "jojo-reader-speech-speed";

function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function savePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Playback also works without storage. */ }
}

function storedVoice(storageKey: string, fallback: SpeechVoice): SpeechVoice {
  const value = readPreference(storageKey);
  return SPEECH_VOICES.some((voice) => voice.id === value) ? value as SpeechVoice : fallback;
}

function storedSpeed(): number {
  const value = Number(readPreference(SPEED_STORAGE_KEY));
  return SPEEDS.includes(value as typeof SPEEDS[number]) ? value : 1;
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? <PauseSolid aria-hidden="true" /> : <PlaySolid aria-hidden="true" />;
}

function CloseIcon() {
  return <Xmark aria-hidden="true" />;
}

function StepIcon({ direction }: { direction: "previous" | "next" }) {
  return direction === "next" ? <SkipNextSolid aria-hidden="true" /> : <SkipPrevSolid aria-hidden="true" />;
}

function SourceIcon() {
  return <Book aria-hidden="true" />;
}

function QueueIcon() {
  return <List aria-hidden="true" />;
}

function TimerIcon() {
  return <Timer aria-hidden="true" />;
}

function VoiceIcon() {
  return <User aria-hidden="true" />;
}

function SpeedIcon() {
  return <DashboardSpeed aria-hidden="true" />;
}

function BookshelfIcon({ added }: { added: boolean }) {
  return added ? <Check aria-hidden="true" /> : <BookStack aria-hidden="true" />;
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const remainder = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function SpeechPlayer(props: Parameters<typeof ActiveSpeechPlayer>[0]) {
  const enabled = useFeatureFlag("reader.speech");
  return enabled ? <ActiveSpeechPlayer {...props} /> : null;
}

function ActiveSpeechPlayer({
  segments,
  label,
  title,
  collectionTitle,
  artworkUrl,
  artworkFallbackUrl,
  contentId,
  miniPlayerTarget,
  queueItems,
  activeQueueId,
  onQueueItemChange,
  defaultVoice = "zh-CN-XiaoxiaoNeural",
}: {
  segments: string[];
  label: string;
  title?: string;
  collectionTitle?: string;
  artworkUrl?: string;
  artworkFallbackUrl?: string;
  contentId?: string;
  miniPlayerTarget?: HTMLElement | null;
  queueItems?: Array<{ id: string; title: string }>;
  activeQueueId?: string;
  onQueueItemChange?: (id: string) => void;
  defaultVoice?: SpeechVoice;
}) {
  const bookshelf = useContext(ReadingBookshelfContext);
  const userId = useAccountSessionStore((session) => session.userId);
  const contentKey = segments.map((value) => value.trim()).filter(Boolean).join("\u0000");
  const progressId = contentId || `${label}:${collectionTitle || title || ""}`;
  const fingerprint = useMemo(() => speechFingerprint(contentKey), [contentKey]);
  const [failedArtwork, setFailedArtwork] = useState<string[]>([]);
  const cover = [artworkUrl, artworkFallbackUrl].find((url) => url && !failedArtwork.includes(url));
  const isNews = label === "听新闻";
  const playableSegments = useMemo(() => contentKey ? contentKey.split("\u0000") : [], [contentKey]);
  const voiceStorageKey = `${VOICE_STORAGE_KEY}:${label}`;
  const [voice, setVoice] = useState<SpeechVoice>(() => storedVoice(voiceStorageKey, defaultVoice));
  const [provider, setProvider] = useState("edge");
  const [providers, setProviders] = useState<SpeechProvider[]>(DEFAULT_SPEECH_PROVIDERS);
  const cacheVersion = providers.find((option) => option.id === provider)?.cacheVersion;
  const [cdnBase, setCdnBase] = useState<string | null>(null);
  const [capabilitiesReady, setCapabilitiesReady] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [providersRevision, setProvidersRevision] = useState(0);
  const [durations, setDurations] = useState<Record<number, number>>({});
  const [speed, setSpeed] = useState(storedSpeed);
  const [state, setState] = useState<PlayerState>("idle");
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [segmentProgress, setSegmentProgress] = useState(0);
  const [wantsPlayback, setWantsPlayback] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [settingPanel, setSettingPanel] = useState<SettingPanel>();
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepAfterChapter, setSleepAfterChapter] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchAudioRef = useRef<HTMLAudioElement | null>(null);
  const sourceDurationsRef = useRef(new Map<string, number>());
  const saveAudioRef = useRef<((force: boolean) => void) | null>(null);
  const speedRef = useRef(speed);
  const cacheRef = useRef(new Map<string, Promise<string>>());
  const objectUrlsRef = useRef(new Set<string>());
  const controllersRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);
  const sleepTimerRef = useRef<number | undefined>(undefined);
  const resumeAfterContentChangeRef = useRef(false);
  const pendingSeekFractionRef = useRef<number | null>(null);
  const queueRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const miniExpandRef = useRef<HTMLButtonElement | null>(null);
  const restoredPreferencesRef = useRef(false);
  const hasDocumentQueue = Boolean(queueItems?.length && onQueueItemChange);
  const activeQueueIndex = hasDocumentQueue
    ? Math.max(0, queueItems!.findIndex((item) => item.id === activeQueueId))
    : segmentIndex;
  const playbackContextRef = useRef({ sleepAfterChapter, hasDocumentQueue, queueItems, activeQueueIndex, onQueueItemChange });
  playbackContextRef.current = { sleepAfterChapter, hasDocumentQueue, queueItems, activeQueueIndex, onQueueItemChange };

  useEffect(() => {
    if (!sessionStarted || !userId) return;
    const controller = new AbortController();
    void loadSpeechProviders(controller.signal).then((capabilities) => {
      setProviders(capabilities.providers);
      setCdnBase(capabilities.cdnBase ?? null);
      setCapabilitiesReady(true);
      setProvidersError("");
      if (restoredPreferencesRef.current) return;
      restoredPreferencesRef.current = true;
      try {
        const saved = readSpeechProgress(progressId) ?? JSON.parse(readPreference(`${voiceStorageKey}:provider`) || "null") as { provider?: string; voice?: string } | null;
        const match = capabilities.providers.find((option) => option.id === saved?.provider && option.available);
        if (match?.voices.some((option) => option.id === saved?.voice)) {
          setProvider(match.id);
          setVoice(saved!.voice!);
        } else if (!saved && capabilities.defaultVoice) {
          setProvider(capabilities.defaultProvider);
          setVoice(capabilities.defaultVoice);
        }
      } catch { /* Invalid saved settings do not prevent playback. */ }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : "无法加载声音列表，请重试";
        setProvidersError(message);
        setError(`${message}，请打开声音设置重试`);
        setWantsPlayback(false);
        setState("error");
      }
    });
    return () => controller.abort();
  }, [sessionStarted, providersRevision, voiceStorageKey, progressId, userId]);

  const stopAudio = useCallback(() => {
    saveAudioRef.current?.(true);
    saveAudioRef.current = null;
    const audio = audioRef.current;
    if (!audio) return;
    audio.onended = null;
    audio.ontimeupdate = null;
    audio.onloadedmetadata = null;
    audio.onerror = null;
    audio.pause();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    if (userId) return;
    stopAudio();
    setWantsPlayback(false);
    setState("idle");
    setPanelOpen(false);
    setSessionStarted(false);
    setCapabilitiesReady(false);
    controllersRef.current.forEach((controller) => controller.abort());
    cacheRef.current.clear();
  }, [userId, stopAudio]);

  const audioUrl = useCallback((text: string, selectedVoice: SpeechVoice): Promise<string> => {
    const key = `${provider}\u0000${selectedVoice}\u0000${text}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      cacheRef.current.delete(key);
      cacheRef.current.set(key, cached);
      return cached;
    }
    const controller = new AbortController();
    controllersRef.current.add(controller);
    const pending = requestSpeech(text, selectedVoice, controller.signal, {
      provider, cdnBase, cacheVersion,
    })
      .then((blob) => {
        if (!(blob instanceof Blob)) {
          sourceDurationsRef.current.set(key, blob.duration);
          return blob.url;
        }
        const url = URL.createObjectURL(blob);
        if (!mountedRef.current) {
          URL.revokeObjectURL(url);
          throw new DOMException("Player closed", "AbortError");
        }
        objectUrlsRef.current.add(url);
        return url;
      })
      .catch((reason) => {
        if (cacheRef.current.get(key) === pending) cacheRef.current.delete(key);
        throw reason;
      })
      .finally(() => controllersRef.current.delete(controller));
    cacheRef.current.set(key, pending);
    // Long books (especially uncompressed WAV) must not retain every segment.
    while (cacheRef.current.size > 12) {
      const oldest = cacheRef.current.keys().next().value!;
      const stale = cacheRef.current.get(oldest)!;
      cacheRef.current.delete(oldest);
      void stale.then((url) => {
        if (objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
      }).catch(() => undefined);
    }
    return pending;
  }, [provider, cdnBase, cacheVersion]);

  useEffect(() => {
    savePreference(voiceStorageKey, voice);
  }, [voice, voiceStorageKey]);

  useEffect(() => {
    savePreference(SPEED_STORAGE_KEY, String(speed));
    speedRef.current = speed;
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    stopAudio();
    setWantsPlayback(false);
    setState("idle");
    const saved = readSpeechProgress(progressId);
    const resume = !resumeAfterContentChangeRef.current && saved?.chapterId === activeQueueId && saved?.fingerprint === fingerprint && saved.segmentIndex < playableSegments.length ? saved : undefined;
    setSegmentIndex(resume?.segmentIndex ?? 0);
    setSegmentProgress((resume?.fraction ?? 0) * 100);
    pendingSeekFractionRef.current = resume?.fraction ?? null;
    setError("");
    if (resumeAfterContentChangeRef.current && playableSegments.length) {
      resumeAfterContentChangeRef.current = false;
      setWantsPlayback(true);
    }
    setDurations({});
  }, [contentKey, progressId, activeQueueId, stopAudio]);

  useEffect(() => {
    if (!sessionStarted || !capabilitiesReady || !userId || !cdnBase || !cacheVersion) return;
    const controller = new AbortController();
    void loadCachedSpeechDurations(playableSegments, voice, controller.signal, { provider, cacheVersion, cdnBase })
      .then((known) => { if (!controller.signal.aborted) setDurations((current) => ({ ...current, ...known })); })
      .catch(() => undefined); // Metadata warming must never prevent playback.
    return () => controller.abort();
  }, [sessionStarted, capabilitiesReady, userId, cdnBase, cacheVersion, playableSegments, voice, provider]);

  useEffect(() => {
    if (!wantsPlayback || !capabilitiesReady || !userId || !playableSegments[segmentIndex]) return;
    let active = true;
    stopAudio();
    setState("loading");
    setError("");
    setSegmentProgress((pendingSeekFractionRef.current ?? 0) * 100);
    void audioUrl(playableSegments[segmentIndex], voice).then(async (url) => {
      if (!active) return;
      const audio = new Audio(url);
      const knownDuration = sourceDurationsRef.current.get(`${provider}\u0000${voice}\u0000${playableSegments[segmentIndex]}`);
      if (knownDuration) setDurations((known) => ({ ...known, [segmentIndex]: knownDuration }));
      audio.preload = "auto";
      audio.playbackRate = speedRef.current;
      let lastSaved = 0;
      saveAudioRef.current = (force) => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0 || (!force && Date.now() - lastSaved < 3000)) return;
        lastSaved = Date.now();
        saveSpeechProgress(progressId, {
          chapterId: activeQueueId, fingerprint, segmentIndex,
          fraction: Math.max(0, Math.min(1, audio.currentTime / audio.duration)),
          provider, voice, updatedAt: lastSaved,
        });
      };
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setDurations((known) => ({ ...known, [segmentIndex]: audio.duration }));
        }
        const pendingFraction = pendingSeekFractionRef.current;
        if (pendingFraction === null || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
        audio.currentTime = pendingFraction * audio.duration;
        setSegmentProgress(pendingFraction * 100);
        pendingSeekFractionRef.current = null;
      };
      audio.ontimeupdate = () => {
        saveAudioRef.current?.(false);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setSegmentProgress(Math.min(100, (audio.currentTime / audio.duration) * 100));
        }
      };
      audio.onended = () => {
        const { sleepAfterChapter, hasDocumentQueue, queueItems, activeQueueIndex, onQueueItemChange } = playbackContextRef.current;
        if (segmentIndex + 1 < playableSegments.length) {
          setSegmentIndex(segmentIndex + 1);
        } else if (sleepAfterChapter) {
          setSleepAfterChapter(false);
          setWantsPlayback(false);
          setSegmentProgress(100);
          setState("complete");
        } else if (hasDocumentQueue && queueItems?.[activeQueueIndex + 1] && onQueueItemChange) {
          resumeAfterContentChangeRef.current = true;
          onQueueItemChange(queueItems[activeQueueIndex + 1]!.id);
        } else {
          setWantsPlayback(false);
          setSegmentProgress(100);
          setState("complete");
        }
      };
      audio.onerror = () => {
        setWantsPlayback(false);
        setState("error");
        setError("音频播放失败，请重试");
      };
      audioRef.current = audio;
      setState("playing");
      await audio.play();
      if (!active) return;
      const next = playableSegments[segmentIndex + 1];
      if (next) void audioUrl(next, voice).then((nextUrl) => {
        if (!active) return;
        const nextAudio = document.createElement("audio");
        nextAudio.preload = "auto";
        nextAudio.src = nextUrl;
        prefetchAudioRef.current = nextAudio;
        const duration = sourceDurationsRef.current.get(`${provider}\u0000${voice}\u0000${next}`);
        if (duration) setDurations((known) => ({ ...known, [segmentIndex + 1]: duration }));
      }).catch(() => undefined);
    }).catch((reason: unknown) => {
      if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setWantsPlayback(false);
      setState("error");
      setError(reason instanceof Error ? reason.message : "语音生成失败");
    });
    return () => {
      active = false;
      if (prefetchAudioRef.current) prefetchAudioRef.current.src = "";
      prefetchAudioRef.current = null;
      stopAudio();
    };
  }, [audioUrl, playableSegments, segmentIndex, stopAudio, voice, wantsPlayback, capabilitiesReady, userId]);

  useEffect(() => {
    if (!panelOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (settingPanel) setSettingPanel(undefined);
        else if (queueOpen) setQueueOpen(false);
        else closePlayer();
      }
      if (event.key === "Tab") {
        const scope = settingPanel ? sheetRef.current : queueOpen ? queueRef.current : dialogRef.current;
        const controls = [...(scope?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])]
          .filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === scope)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [panelOpen, queueOpen, settingPanel]);

  useEffect(() => {
    if (panelOpen) dialogRef.current?.focus({ preventScroll: true });
    else if (sessionStarted) miniExpandRef.current?.focus({ preventScroll: true });
  }, [panelOpen]);

  useEffect(() => {
    if (!sessionStarted || panelOpen) return;
    document.body.dataset.speechMini = miniPlayerTarget ? "docked" : bookshelf ? "reader" : "article";
    return () => { delete document.body.dataset.speechMini; };
  }, [sessionStarted, panelOpen, Boolean(bookshelf), miniPlayerTarget]);

  useEffect(() => {
    if (!settingPanel) return;
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, [settingPanel]);

  useEffect(() => {
    if (!queueOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    queueRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, [queueOpen]);

  useEffect(() => {
    if (sleepTimerRef.current !== undefined) window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = undefined;
    if (!sleepMinutes) return;
    sleepTimerRef.current = window.setTimeout(() => {
      const audio = audioRef.current;
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        pendingSeekFractionRef.current = audio.currentTime / audio.duration;
      }
      setWantsPlayback(false);
      audio?.pause();
      setState("paused");
      setSleepMinutes(0);
    }, sleepMinutes * 60_000);
    return () => {
      if (sleepTimerRef.current !== undefined) window.clearTimeout(sleepTimerRef.current);
    };
  }, [sleepMinutes]);

  useEffect(() => {
    mountedRef.current = true;
    const save = () => saveAudioRef.current?.(true);
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
      mountedRef.current = false;
      stopAudio();
      if (sleepTimerRef.current !== undefined) window.clearTimeout(sleepTimerRef.current);
      controllersRef.current.forEach((controller) => controller.abort());
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stopAudio]);

  function togglePlayback(): void {
    if (!userId) return;
    if (!playableSegments.length) return;
    if (state === "playing" && audioRef.current) {
      audioRef.current.pause();
      saveAudioRef.current?.(true);
      setState("paused");
      return;
    }
    if (state === "loading") {
      setWantsPlayback(false);
      setState("paused");
      return;
    }
    if (state === "paused" && audioRef.current) {
      void audioRef.current.play().then(() => setState("playing")).catch(() => {
        setState("error");
        setError("音频播放失败，请重试");
      });
      return;
    }
    if (state === "complete") {
      setSegmentIndex(0);
      setSegmentProgress(0);
      pendingSeekFractionRef.current = null;
    }
    setWantsPlayback(true);
    if (!capabilitiesReady) setState("loading");
  }

  function closePlayer(): void {
    setSettingPanel(undefined);
    setQueueOpen(false);
    setPanelOpen(false);
    launcherRef.current?.focus();
  }

  function openPlayer(): void {
    if (!userId) {
      setPanelOpen(true);
      return;
    }
    if (!sessionStarted) {
      const saved = readSpeechProgress(progressId);
      if (saved?.chapterId && saved.chapterId !== activeQueueId && queueItems?.some((item) => item.id === saved.chapterId)) {
        onQueueItemChange?.(saved.chapterId);
      }
    }
    setSessionStarted(true);
    setPanelOpen(true);
  }

  function dismissMini(): void {
    pendingSeekFractionRef.current = segmentProgress / 100;
    stopAudio();
    setWantsPlayback(false);
    setState("paused");
    setSessionStarted(false);
    launcherRef.current?.focus();
  }

  function chooseVoice(selectedProvider: SpeechProvider, selectedVoice: string): void {
    if (provider !== selectedProvider.id || voice !== selectedVoice) {
      pendingSeekFractionRef.current = segmentProgress / 100;
      stopAudio();
      setError("");
      setDurations({});
      setWantsPlayback(state === "playing" || state === "loading");
      setState(state === "playing" || state === "loading" ? "loading" : state === "idle" ? "idle" : "paused");
      setProvider(selectedProvider.id);
      setVoice(selectedVoice);
      savePreference(`${voiceStorageKey}:provider`, JSON.stringify({ provider: selectedProvider.id, voice: selectedVoice }));
    }
    setSettingPanel(undefined);
  }

  function chooseSleepTimer(minutes: number): void {
    setSleepAfterChapter(false);
    setSleepMinutes(minutes);
    setSettingPanel(undefined);
  }

  function chooseSleepAfterChapter(): void {
    setSleepMinutes(0);
    setSleepAfterChapter(true);
    setSettingPanel(undefined);
  }

  function jumpToSegment(nextIndex: number): void {
    if (!playableSegments[nextIndex]) return;
    if (nextIndex === segmentIndex && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play().then(() => setState("playing")).catch(() => setError("音频播放失败，请重试"));
    }
    pendingSeekFractionRef.current = null;
    setSegmentIndex(nextIndex);
    setWantsPlayback(true);
  }

  function jumpToQueueItem(nextIndex: number): void {
    if (!hasDocumentQueue) {
      jumpToSegment(nextIndex);
      return;
    }
    const item = queueItems?.[nextIndex];
    if (!item || !onQueueItemChange) return;
    if (item.id === activeQueueId) {
      jumpToSegment(0);
      return;
    }
    resumeAfterContentChangeRef.current = true;
    onQueueItemChange(item.id);
  }

  function skip(seconds: number): void {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  }

  function seekChapter(value: number): void {
    if (!playableSegments.length || !totalWeight) return;
    const targetWeight = Math.min(Math.max(0, totalWeight - 0.000001), Math.max(0, value / 100 * totalWeight));
    let traversed = 0;
    let targetIndex = 0;
    for (let index = 0; index < segmentWeights.length; index += 1) {
      const nextBoundary = traversed + segmentWeights[index]!;
      if (targetWeight < nextBoundary) {
        targetIndex = index;
        break;
      }
      traversed = nextBoundary;
    }
    const targetFraction = Math.max(0, Math.min(1, (targetWeight - traversed) / segmentWeights[targetIndex]!));
    const audio = audioRef.current;
    if (targetIndex === segmentIndex && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = targetFraction * audio.duration;
      setSegmentProgress(targetFraction * 100);
      return;
    }
    pendingSeekFractionRef.current = targetFraction;
    setSegmentIndex(targetIndex);
    setWantsPlayback(true);
  }

  function showQueue(): void {
    setSettingPanel(undefined);
    setQueueOpen(true);
  }

  const segmentWeights = playableSegments.map((segment, index) => durations[index] ?? Math.max(1, segment.length / 4.2));
  const totalWeight = segmentWeights.reduce((sum, weight) => sum + weight, 0);
  const completedWeight = segmentWeights.slice(0, segmentIndex).reduce((sum, weight) => sum + weight, 0);
  const totalProgress = totalWeight
    ? Math.min(100, ((completedWeight + segmentWeights[segmentIndex]! * segmentProgress / 100) / totalWeight) * 100)
    : 0;
  const estimatedDuration = totalWeight;
  const estimatedElapsed = estimatedDuration * totalProgress / 100;
  const elapsedTimeLabel = formatTime(estimatedElapsed);
  const durationTimeLabel = totalWeight ? formatTime(estimatedDuration) : "--:--";
  const active = state === "playing" || state === "loading";
  const status = error || (
    state === "loading" ? "正在准备音频…"
      : state === "playing" ? "正在朗读"
        : state === "paused" ? "已暂停"
          : state === "complete" ? "本篇播放完成"
            : segmentIndex > 0 || segmentProgress > 0 ? "从上次听到的位置继续" : "准备播放"
  );
  const displayTitle = title || playableSegments[0] || label;
  const visibleQueue = hasDocumentQueue
    ? queueItems!
    : playableSegments.map((segment, index) => ({ id: String(index), title: index === 0 ? displayTitle : segment }));
  const queueUnit = hasDocumentQueue ? "章" : "段";
  const selectedVoiceLabel = providers.find((option) => option.id === provider)?.voices.find((option) => option.id === voice)?.label ?? "选择声音";
  const sleepLabel = sleepAfterChapter ? (hasDocumentQueue ? "本章结束" : "本篇结束") : sleepMinutes ? `${sleepMinutes} 分钟` : "关闭";
  const settingTitle = settingPanel === "sleep" ? "定时关闭" : settingPanel === "voice" ? "选择声音" : "语速设置";

  const panel = panelOpen ? createPortal(
    <div className="speech-player__overlay" onKeyDown={(event) => event.stopPropagation()}>
      <div ref={dialogRef} tabIndex={-1} className={`speech-player__dialog${isNews ? " is-news" : ""}`} role="dialog" aria-modal="true" aria-label={`${label}播放器`}>
        {cover && <div className="speech-player__ambience" aria-hidden="true"><img src={cover} alt="" /></div>}
        <header className="speech-player__header">
          <button type="button" className="speech-player__close" onClick={closePlayer} aria-label="收起听读播放器">
            <NavArrowDown aria-hidden="true" />
          </button>
          <div className="speech-player__mode">
            <span>{label === "听新闻" ? "听新闻" : "听书"}</span>
          </div>
          <span className="speech-player__chapter-count">
            {hasDocumentQueue ? `第 ${activeQueueIndex + 1} / ${visibleQueue.length} 章` : `第 ${segmentIndex + 1} / ${playableSegments.length} 段`}
          </span>
        </header>

        <main className="speech-player__panel">
          <section className="speech-player__now" aria-label="当前播放">
              <div className={`speech-player__artwork${cover ? " has-image" : ""}${cover && cover === artworkFallbackUrl ? " is-logo" : ""}`} aria-hidden="true">
                {cover ? <img src={cover} alt="" onError={() => setFailedArtwork((failed) => [...failed, cover])} /> : <><span>{collectionTitle || "JOJO 看报"}</span><b>{isNews ? "JOJO 时事" : displayTitle}</b></>}
              </div>
              <div className="speech-player__identity">
                <p>{collectionTitle || (label === "听新闻" ? "JOJO 时事" : "JOJO 资料库")}</p>
                <h2>{displayTitle}</h2>
              </div>

            <div className={`speech-player__settings${bookshelf?.available ? " has-bookshelf" : ""}`}>
              <button type="button" className="speech-player__setting" onClick={() => setSettingPanel("sleep")} aria-label="设置定时关闭">
                <TimerIcon />
                <span>{sleepLabel === "关闭" ? "定时关闭" : sleepLabel}</span>
              </button>
              <button type="button" className="speech-player__setting" onClick={() => setSettingPanel("voice")} aria-label="选择听读声音">
                <VoiceIcon />
                <span>{selectedVoiceLabel}</span>
              </button>
              <button type="button" className="speech-player__setting" onClick={() => setSettingPanel("speed")} aria-label="设置听读语速">
                <SpeedIcon />
                <span>语速 {Number.isInteger(speed) ? speed.toFixed(1) : speed}×</span>
              </button>
              {bookshelf?.available && <button
                type="button"
                className="speech-player__setting speech-player__bookshelf"
                aria-pressed={bookshelf.added}
                aria-label={bookshelf.added ? "移出书架" : "加入书架"}
                disabled={bookshelf.busy}
                onClick={bookshelf.toggle}
              >
                <BookshelfIcon added={bookshelf.added} />
                <span>{bookshelf.busy ? "处理中…" : bookshelf.added ? "已加入" : "加入书架"}</span>
              </button>}
            </div>

            <div className="speech-player__seek-row">
              <button type="button" className="speech-player__seek-skip" onClick={() => skip(-15)} disabled={!audioRef.current} aria-label="后退15秒" title="后退 15 秒"><Backward15Seconds width={32} height={32} strokeWidth={1.5} aria-hidden="true" /></button>
              <div className="speech-player__timeline">
                <div>
                  <span className="speech-player__time">{elapsedTimeLabel}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={totalProgress}
                    onChange={(event) => seekChapter(Number(event.target.value))}
                    aria-label={hasDocumentQueue ? "当前章节播放进度" : "全文播放进度"}
                    aria-valuetext={`${elapsedTimeLabel} / ${durationTimeLabel}`}
                    style={{ "--speech-progress": `${totalProgress}%` } as CSSProperties}
                  />
                  <span className="speech-player__time" title="未加载音频的时长按字数估算，播放后自动校准">{durationTimeLabel}</span>
                </div>
              </div>
              <button type="button" className="speech-player__seek-skip" onClick={() => skip(15)} disabled={!audioRef.current} aria-label="前进15秒" title="前进 15 秒"><Forward15Seconds width={32} height={32} strokeWidth={1.5} aria-hidden="true" /></button>
            </div>
            <p aria-live="polite" className={`speech-player__status${error ? " speech-player__error" : ""}`}>{status}</p>

            <div className="speech-player__transport">
              <button type="button" className="speech-player__transport-utility" onClick={closePlayer} aria-label="返回原文" title="返回原文"><SourceIcon /><span>原文</span></button>
              <button type="button" onClick={() => hasDocumentQueue ? jumpToQueueItem(activeQueueIndex - 1) : jumpToSegment(segmentIndex - 1)} disabled={hasDocumentQueue ? activeQueueIndex === 0 : segmentIndex === 0} aria-label={hasDocumentQueue ? "上一章" : "上一段"} title={hasDocumentQueue ? "上一章" : "上一段"}><StepIcon direction="previous" /></button>
              <button type="button" className="speech-player__primary" onClick={togglePlayback} disabled={!playableSegments.length} aria-label={active ? "暂停听读" : state === "paused" ? "继续听读" : "开始听读"}><PlayIcon playing={active} /></button>
              <button type="button" onClick={() => hasDocumentQueue ? jumpToQueueItem(activeQueueIndex + 1) : jumpToSegment(segmentIndex + 1)} disabled={hasDocumentQueue ? activeQueueIndex >= visibleQueue.length - 1 : segmentIndex >= playableSegments.length - 1} aria-label={hasDocumentQueue ? "下一章" : "下一段"} title={hasDocumentQueue ? "下一章" : "下一段"}><StepIcon direction="next" /></button>
              <button type="button" className="speech-player__transport-utility" onClick={showQueue} aria-label="打开章节列表" aria-expanded={queueOpen} aria-controls="speech-player-queue" title="打开章节列表"><QueueIcon /><span>{visibleQueue.length}{queueUnit}</span></button>
            </div>
          </section>

          {queueOpen && <button type="button" className="speech-player__queue-backdrop" onClick={() => setQueueOpen(false)} aria-label="点击遮罩关闭章节列表" />}
          <aside id="speech-player-queue" ref={queueRef} tabIndex={-1} hidden={!queueOpen} className={`speech-player__queue${queueOpen ? " is-open" : ""}`} aria-label={hasDocumentQueue ? "章节列表" : "听读段落"}>
            <header>
              <div><span>{hasDocumentQueue ? collectionTitle || "当前书籍" : "当前内容"}</span><strong>{hasDocumentQueue ? "章节列表" : "听读段落"}</strong></div>
              <b>{visibleQueue.length} {queueUnit}</b>
              <button type="button" className="speech-player__queue-close" onClick={() => setQueueOpen(false)} aria-label="关闭章节列表"><CloseIcon /></button>
            </header>
            <ol>
              {visibleQueue.map((item, index) => {
                const current = index === activeQueueIndex;
                return <li key={item.id}>
                  <button type="button" className={current ? "is-current" : undefined} onClick={() => { setQueueOpen(false); jumpToQueueItem(index); }} aria-current={current ? "true" : undefined}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.title}</strong>
                    {current && <Headset aria-label={active ? "正在播放" : `当前${queueUnit}`} />}
                  </button>
                </li>;
              })}
            </ol>
          </aside>
        </main>
      </div>
      {settingPanel && <div className="speech-player__sheet-layer">
        <button type="button" className="speech-player__sheet-backdrop" onClick={() => setSettingPanel(undefined)} aria-label="关闭设置" />
        <section ref={sheetRef} tabIndex={-1} className="speech-player__sheet" role="dialog" aria-modal="true" aria-label={`${settingTitle}设置`}>
          <header>
            <h3>{settingTitle}</h3>
            <button type="button" onClick={() => setSettingPanel(undefined)} aria-label="关闭设置"><CloseIcon /></button>
          </header>
          {settingPanel === "sleep" && <>
            <div className="speech-player__sheet-options speech-player__sheet-options--timer" role="group" aria-label="定时关闭选项">
              {SLEEP_TIMERS.map((minutes) => <button
                type="button"
                key={minutes}
                className={!sleepAfterChapter && sleepMinutes === minutes ? "is-selected" : undefined}
                aria-pressed={!sleepAfterChapter && sleepMinutes === minutes}
                onClick={() => chooseSleepTimer(minutes)}
              >{minutes ? `${minutes} 分钟` : "关闭"}</button>)}
            </div>
            <button type="button" className={`speech-player__sheet-end${sleepAfterChapter ? " is-selected" : ""}`} aria-pressed={sleepAfterChapter} onClick={chooseSleepAfterChapter}>
              <strong>{hasDocumentQueue ? "本章结束后停止" : "本篇结束后停止"}</strong>
              <span>{hasDocumentQueue ? "读完当前章节后不自动播放下一章" : "读完当前内容后停止播放"}</span>
            </button>
          </>}
          {settingPanel === "voice" && <>
            {providersError && <p className="speech-player__provider-error" role="alert">{providersError} <button type="button" onClick={() => setProvidersRevision((value) => value + 1)}>重试</button></p>}
            <div className="speech-player__sheet-options speech-player__sheet-options--voice" role="group" aria-label="声音选项">
              {providers.filter((source) => source.available).flatMap((source) => source.voices.map((option) => <button type="button" key={`${source.id}:${option.id}`}
                    className={provider === source.id && voice === option.id ? "is-selected" : undefined}
                    aria-pressed={provider === source.id && voice === option.id}
                    onClick={() => chooseVoice(source, option.id)}>
                    <User aria-hidden="true" /><span><strong>{option.label}</strong><small>{option.description}</small></span>
                    {provider === source.id && voice === option.id && <Check aria-hidden="true" />}
                  </button>))}
            </div>
            <p className="speech-player__privacy-note">已有音频直接播放；尚未生成时，会将正文发送给所选声音服务合成。</p>
          </>}
          {settingPanel === "speed" && <div className="speech-player__sheet-options speech-player__sheet-options--speed" role="group" aria-label="语速选项">
            {SPEEDS.map((value) => <button
              type="button"
              key={value}
              className={speed === value ? "is-selected" : undefined}
              aria-pressed={speed === value}
              onClick={() => { setSpeed(value); setSettingPanel(undefined); }}
            >{value}×</button>)}
          </div>}
        </section>
      </div>}
    </div>,
    document.body,
  ) : null;

  const launcher = <section className={`speech-player${miniPlayerTarget ? " is-docked" : ""}`} aria-label={label} aria-hidden={bookshelf?.chromeHidden || undefined} inert={bookshelf?.chromeHidden}>
    <button ref={launcherRef} type="button" className={`speech-player__launcher${active ? " is-playing" : ""}`} onClick={openPlayer} disabled={!playableSegments.length} aria-label={`打开${label}播放器`}>
      <span className="speech-player__launcher-mark">听</span>
    </button>
  </section>;
  const mini = sessionStarted && !panelOpen ? createPortal(
    <section className={`speech-mini${bookshelf ? " is-reader" : ""}${miniPlayerTarget ? " is-docked" : ""}`} aria-label="迷你听读播放器" aria-hidden={bookshelf?.chromeHidden || undefined} inert={bookshelf?.chromeHidden} onKeyDown={(event) => event.stopPropagation()}>
      {cover && <div className="speech-player__ambience speech-mini__ambience" aria-hidden="true"><img src={cover} alt="" /></div>}
      <div className="speech-mini__inner">
        <button ref={miniExpandRef} type="button" className="speech-mini__content" onClick={openPlayer} aria-label={`展开播放器：${displayTitle}`}>
          <span className={`speech-mini__cover${isNews ? " is-news" : ""}`}>{cover ? <img src={cover} alt="" onError={() => setFailedArtwork((failed) => [...failed, cover])} /> : <Headset aria-hidden="true" />}</span>
          <span className="speech-mini__identity"><strong>{displayTitle}</strong><small>{state === "loading" || error ? status : `${collectionTitle || label} · ${selectedVoiceLabel}`}</small></span>
        </button>
        <span className="speech-mini__time">{elapsedTimeLabel} / {durationTimeLabel}</span>
        <button type="button" className="speech-mini__play" onClick={togglePlayback} aria-label={active ? "暂停听读" : "继续听读"}><PlayIcon playing={active} /></button>
        <button type="button" onClick={() => { openPlayer(); showQueue(); }} aria-label="打开章节列表"><QueueIcon /></button>
        <button type="button" onClick={dismissMini} aria-label="关闭迷你播放器"><CloseIcon /></button>
      </div>
      <div className="speech-mini__progress" aria-hidden="true"><span style={{ width: `${totalProgress}%` }} /></div>
    </section>, miniPlayerTarget || document.body,
  ) : null;
  const loginPanel = panelOpen && !userId ? createPortal(
    <div className="speech-player__overlay" onKeyDown={(event) => { if (event.key === "Escape") setPanelOpen(false); }}>
      <div ref={dialogRef} tabIndex={-1} className="speech-player__login" role="dialog" aria-modal="true" aria-label="登录后听读">
      <h2>登录后即可听书、听新闻</h2><p>听到的位置会保存在当前浏览器。</p>
      <div className="speech-player__login-actions"><a href={`/account?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>前往登录</a>
      <button type="button" onClick={() => setPanelOpen(false)}>暂不登录</button>
      </div></div></div>, document.body) : null;
  return <>{bookshelf?.speechLauncherTarget ? createPortal(launcher, bookshelf.speechLauncherTarget) : !mini && (miniPlayerTarget ? createPortal(launcher, miniPlayerTarget) : launcher)}{userId ? panel : loginPanel}{userId && mini}</>;
}
