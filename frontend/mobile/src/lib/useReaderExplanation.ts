import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createReaderExplanation, type ExplanationCallbacks, type ExplanationRequest } from "@jojo/ui/reader-explanation";

// Keep React owned by this app; native and Web use different renderer versions.
export function useReaderExplanation<Anchor, Metadata>(
  transport: (anchor: Anchor, callbacks: ExplanationCallbacks<Metadata>, request: ExplanationRequest) => () => void,
  contextKey: string,
) {
  const send = useRef(transport);
  send.current = transport;
  const [chat] = useState(() => createReaderExplanation<Anchor, Metadata>((...args) => send.current(...args)));
  const conversation = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getSnapshot);
  useEffect(() => { chat.close(); return chat.close; }, [chat, contextKey]);
  return { ...chat, conversation };
}
