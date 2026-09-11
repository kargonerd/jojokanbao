import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, type StyleProp, type ViewStyle, type TextStyle } from "react-native";
import type { ScrapbookDraft, ScrapbookSource } from "@jojo/auth";
import { useMobileAuthStore } from "../account/auth";
import { mobileTheme } from "../theme/tokens";
import { mobileScrapbook } from "./api";
import { ScrapbookEditor } from "./ScrapbookEditor";

export function ScrapbookCapture({ source, quote = "", onClose, onSaved }: {
  source: ScrapbookSource; quote?: string; onClose: () => void; onSaved?: () => void;
}) {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const [owner] = useState(userId);
  const mounted = useRef(false);
  const invalidated = useRef(false);
  const submitting = useRef(false);
  const [initial] = useState<ScrapbookDraft>(() => ({ ...source, quote: quote.slice(0, 6000), note: "", collection: "" }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (owner !== userId && !invalidated.current) {
      invalidated.current = true;
      onClose();
    }
  }, [owner, userId, onClose]);
  function ownsCapture() {
    return mounted.current && !invalidated.current && Boolean(owner)
      && useMobileAuthStore.getState().user?.id === owner;
  }
  async function save(value: ScrapbookDraft) {
    if (!owner || !ownsCapture() || submitting.current) return;
    submitting.current = true;
    setSaving(true); setError("");
    try { await mobileScrapbook.save(value); if (ownsCapture()) { onSaved?.(); onClose(); } }
    catch (reason) { if (ownsCapture()) setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { submitting.current = false; if (ownsCapture()) setSaving(false); }
  }
  if (!owner || owner !== userId || invalidated.current) return null;
  return <ScrapbookEditor initial={initial} saving={saving} error={error} onSave={(value) => void save(value)} onClose={onClose} />;
}
export function ScrapbookButton({ source, quote = "", onLogin, label = "加入剪报本", style, textStyle }: {
  source: ScrapbookSource; quote?: string; onLogin: () => void; label?: string;
  style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>;
}) {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const [snapshot, setSnapshot] = useState<{ ownerId: string; source: ScrapbookSource; quote: string }>();
  const [savedOwner, setSavedOwner] = useState<string>();
  const saved = Boolean(userId) && savedOwner === userId;
  useLayoutEffect(() => { setSnapshot(undefined); setSavedOwner(undefined); }, [userId, source.contentUrl, quote]);
  return <>
    <Pressable accessibilityRole="button" style={style} onPress={() => {
      if (!userId) { onLogin(); return; }
      setSavedOwner(undefined); setSnapshot({ ownerId: userId, source: { ...source }, quote });
    }}><Text style={[{ color: mobileTheme.red, paddingVertical: 10, fontFamily: mobileTheme.serif }, textStyle]}>{saved ? "已加入剪报本" : label}</Text></Pressable>
    {snapshot && snapshot.ownerId === userId && <ScrapbookCapture source={snapshot.source} quote={snapshot.quote} onClose={() => setSnapshot(undefined)} onSaved={() => { if (useMobileAuthStore.getState().user?.id === snapshot.ownerId) setSavedOwner(snapshot.ownerId); }} />}
  </>;
}
