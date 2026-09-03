import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobileAuthStore } from "../account/auth";
import { AuthenticatedFeatureGate } from "../components/AuthenticatedFeatureGate";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import type { MobileBookAgentMessage, MobileBookAgentReference } from "../lib/bookAgent";
import { loadMobileBooks, loadMobileBookVolumes, type MobileBook } from "../lib/books";
import { askMobileLibraryAgent } from "../lib/libraryAgent";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { useMobileStore, type MobileAiConversation } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

function readableAiText(value: string): string {
  return value
    .replace(/\[cite:[A-Za-z0-9_-]+\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

function conversationTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  const theme = mobileTheme;
  return (
    <Modal
      visible={visible}
      transparent
      animationType={IS_EINK_RELEASE ? "none" : "fade"}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.modalRoot}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.modalBackdrop} />
        <SafeAreaView edges={["top", "bottom"]} style={[styles.sheet, { backgroundColor: theme.paper, borderColor: theme.ruleDark }]}>
          <View style={[styles.sheetHeader, { borderBottomColor: theme.ruleDark }]}>
            <Text style={[styles.sheetTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={24} color={theme.red} />
            </Pressable>
          </View>
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function ReferenceLinks({
  references,
  onOpen,
}: {
  references?: MobileBookAgentReference[];
  onOpen(reference: MobileBookAgentReference): void;
}) {
  const theme = mobileTheme;
  if (!references?.length) return null;
  return (
    <View style={styles.references}>
      {references.map((reference, index) => {
        const enabled = Boolean(reference.datasetId && reference.itemId && reference.targetId);
        return (
          <Pressable
            key={`${reference.citationId ?? "ref"}:${reference.itemId ?? index}:${reference.targetId ?? ""}`}
            accessibilityRole="button"
            disabled={!enabled}
            onPress={() => onOpen(reference)}
            style={[styles.reference, { borderColor: theme.ruleDark, opacity: enabled ? 1 : 0.55 }]}
          >
            <Text numberOfLines={1} style={[styles.referenceText, { color: theme.red, fontFamily: theme.sans }]}>
              {index + 1}. {reference.title || reference.itemTitle || "查看引用原文"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function AiScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList & MainTabParamList>>();
  const initialized = useMobileAuthStore((state) => state.initialized);
  const user = useMobileAuthStore((state) => state.user);
  const ownerId = user?.id ?? "";
  const savedConversations = useMobileStore((state) => state.aiConversations);
  const upsertConversation = useMobileStore((state) => state.upsertAiConversation);
  const removeConversation = useMobileStore((state) => state.removeAiConversation);
  const theme = mobileTheme;
  const listRef = useRef<FlatList<MobileBookAgentMessage>>(null);
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const [books, setBooks] = useState<MobileBook[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(false);
  const [booksError, setBooksError] = useState("");
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<MobileBookAgentMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState("");

  const conversations = useMemo(
    () => savedConversations.filter((conversation) => conversation.ownerId === ownerId),
    [ownerId, savedConversations],
  );
  const selectedTitles = selectedDatasetIds.flatMap((id) => {
    const book = books.find((candidate) => candidate.datasetId === id);
    return book ? [book.title] : [];
  });
  const scopeLabel = selectedTitles.length === 0
    ? "全部书籍"
    : selectedTitles.length === 1
      ? `仅《${selectedTitles[0]}》`
      : `限定 ${selectedTitles.length} 本书`;
  const visibleBooks = useMemo(() => {
    const needle = scopeQuery.trim().toLocaleLowerCase("zh-CN");
    return needle ? books.filter((book) => book.title.toLocaleLowerCase("zh-CN").includes(needle)) : books;
  }, [books, scopeQuery]);
  const hasThread = messages.length > 0 || streaming || Boolean(error);
  const canSend = Boolean(input.trim() && books.length && !loadingBooks && !streaming);

  useEffect(() => () => cancelRef.current?.(), []);

  useEffect(() => {
    if (!ownerId) return;
    let active = true;
    setLoadingBooks(true);
    setBooksError("");
    void loadMobileBooks()
      .then((items) => {
        if (active) setBooks(items.filter((item) => item.aiEnabled === true));
      })
      .catch((reason: unknown) => {
        if (active) setBooksError(reason instanceof Error ? reason.message : "书目加载失败");
      })
      .finally(() => { if (active) setLoadingBooks(false); });
    return () => { active = false; };
  }, [ownerId]);

  useEffect(() => {
    if (hasThread) requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: !IS_EINK_RELEASE }));
  }, [hasThread, messages, streamContent, streamStatus]);

  function startNewConversation(resetScope = true) {
    if (streaming) return;
    setConversationId("");
    setMessages([]);
    setStreamContent("");
    setStreamStatus("");
    setError("");
    if (resetScope) setSelectedDatasetIds([]);
  }

  function chooseScope(next: string[]) {
    if (streaming) return;
    startNewConversation(false);
    setSelectedDatasetIds(next);
  }

  function openConversation(conversation: MobileAiConversation) {
    if (streaming) return;
    setConversationId(conversation.id);
    setMessages(conversation.messages);
    setSelectedDatasetIds(conversation.selectedDatasetIds);
    setStreamContent("");
    setStreamStatus("");
    setError("");
    setHistoryOpen(false);
  }

  function openReference(reference: MobileBookAgentReference) {
    if (!reference.datasetId || !reference.itemId || !reference.targetId) return;
    navigation.navigate("BookReader", {
      datasetId: reference.datasetId,
      itemKey: reference.itemId,
      title: reference.itemTitle || reference.title || "引用原文",
      bookTitle: reference.datasetTitle || "资料库",
      initialChapterId: reference.targetId,
      initialAnchorId: reference.anchorId,
      initialText: reference.excerpt,
      returnToReference: true,
    });
  }

  function sendMessage() {
    const question = input.trim();
    if (!question || !canSend || !ownerId) return;
    const datasetIds = selectedDatasetIds.length ? selectedDatasetIds : books.map((book) => book.datasetId);
    const previousMessages = messages;
    const nextMessages = [...messages, { role: "user" as const, content: question }];
    setInput("");
    setMessages(nextMessages);
    setStreaming(true);
    setStreamContent("");
    setStreamStatus("正在准备检索范围…");
    setError("");

    void (async () => {
      let itemIds: string[] | undefined;
      let manifestObjects: string[] | undefined;
      if (selectedDatasetIds.length === 1) {
        const book = books.find((candidate) => candidate.datasetId === selectedDatasetIds[0]);
        if (book) {
          try {
            const volumes = await loadMobileBookVolumes(book);
            if (volumes.length === 1 && volumes[0]) {
              itemIds = [volumes[0].itemId];
              manifestObjects = [volumes[0].manifestObject];
            }
          } catch {
            // The service can still use its remote multi-book search path.
          }
        }
      }
      let answer = "";
      cancelRef.current = askMobileLibraryAgent({
        question,
        datasetIds,
        scopeMode: selectedDatasetIds.length ? "selected" : "all",
        conversationId: conversationId || undefined,
        history: previousMessages,
        itemIds,
        manifestObjects,
      }, {
        onChunk: (chunk) => {
          answer += chunk;
          setStreamContent(answer);
        },
        onActivity: (activity) => setStreamStatus(activity.message),
        onDone: (nextConversationId, references) => {
          const completedMessages = [
            ...nextMessages,
            { role: "assistant" as const, content: answer, references },
          ];
          const now = Date.now();
          const previous = conversations.find((candidate) => candidate.id === nextConversationId);
          upsertConversation({
            id: nextConversationId,
            ownerId,
            title: completedMessages.find((message) => message.role === "user")?.content.slice(0, 80) || "新对话",
            createdAt: previous?.createdAt ?? now,
            lastMessageAt: now,
            selectedDatasetIds: [...selectedDatasetIds],
            messages: completedMessages,
          });
          setConversationId(nextConversationId);
          setMessages(completedMessages);
          setStreaming(false);
          setStreamContent("");
          setStreamStatus("");
          cancelRef.current = undefined;
        },
        onError: (message) => {
          setStreaming(false);
          setStreamContent("");
          setStreamStatus("");
          setError(message);
          cancelRef.current = undefined;
        },
      });
    })();
  }

  function renderComposer(prominent: boolean) {
    return (
      <View style={[
        styles.composer,
        prominent && styles.prominentComposer,
        { borderColor: theme.ruleDark, backgroundColor: theme.paper },
      ]}>
        <View style={styles.composerRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            multiline
            placeholder="输入问题"
            placeholderTextColor={theme.muted}
            accessibilityLabel="输入问题"
            editable={!streaming}
            style={[styles.composerInput, prominent && styles.prominentInput, { color: theme.ink, fontFamily: theme.sans }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            disabled={!canSend}
            onPress={sendMessage}
            style={[styles.sendButton, { backgroundColor: canSend ? theme.red : theme.rule }]}
          >
            <Ionicons name="arrow-up" size={18} color={canSend ? theme.inverse : theme.muted} />
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`选择书籍，当前${scopeLabel}`}
          disabled={streaming}
          onPress={() => setScopeOpen(true)}
          style={[styles.scopeButton, { borderTopColor: theme.rule }]}
        >
          <Text numberOfLines={1} style={[styles.scopeText, { color: theme.red, fontFamily: theme.sans }]}>{scopeLabel}</Text>
          <Ionicons name="chevron-up" size={13} color={theme.red} />
        </Pressable>
      </View>
    );
  }

  if (!initialized || !user) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
        <ScreenHeader title="AI" showAccount />
        <AuthenticatedFeatureGate
          initialized={initialized}
          signedIn={Boolean(user)}
          description="登录后可向全部馆藏提问，并在本机保留历史对话。"
          onSignIn={() => navigation.navigate("Account")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="AI" showAccount />
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.historyBar, { backgroundColor: theme.paper, borderBottomColor: theme.rule }]}>
          <Pressable accessibilityRole="button" onPress={() => setHistoryOpen(true)} style={styles.historyButton}>
            <Ionicons name="time-outline" size={16} color={theme.red} />
            <Text style={[styles.historyLabel, { color: theme.red, fontFamily: theme.sans }]}>历史对话</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={streaming} onPress={() => startNewConversation()} style={styles.newButton}>
            <Ionicons name="add" size={17} color={theme.red} />
            <Text style={[styles.historyLabel, { color: theme.red, fontFamily: theme.sans }]}>新对话</Text>
          </Pressable>
        </View>

        {booksError ? (
          <View style={[styles.errorBox, { borderColor: theme.red, backgroundColor: theme.paper }]}>
            <Text style={[styles.errorText, { color: theme.red, fontFamily: theme.sans }]}>{booksError}</Text>
          </View>
        ) : null}

        {!hasThread ? (
          <View style={styles.emptyConversation}>
            <View style={styles.emptyComposerWrap}>
              {loadingBooks ? (
                <Text style={[styles.loadingText, { color: theme.muted, fontFamily: theme.sans }]}>正在加载书籍…</Text>
              ) : books.length ? renderComposer(true) : (
                <Text style={[styles.loadingText, { color: theme.muted, fontFamily: theme.sans }]}>当前没有可供 AI 检索的书籍</Text>
              )}
            </View>
          </View>
        ) : (
          <>
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(_, index) => `${conversationId || "new"}:${index}`}
              contentContainerStyle={styles.messages}
              keyboardShouldPersistTaps="handled"
              overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
              renderItem={({ item }) => item.role === "user" ? (
                <View style={[styles.userMessage, { backgroundColor: theme.paperSoft, borderColor: theme.rule }]}>
                  <Text selectable style={[styles.userText, { color: theme.ink, fontFamily: theme.sans }]}>{item.content}</Text>
                </View>
              ) : (
                <View style={[styles.assistantMessage, { borderLeftColor: theme.red }]}>
                  <Text selectable style={[styles.assistantText, { color: theme.ink, fontFamily: theme.serif }]}>{readableAiText(item.content)}</Text>
                  <ReferenceLinks references={item.references} onOpen={openReference} />
                </View>
              )}
              ListFooterComponent={streaming || error ? (
                <View style={[styles.assistantMessage, { borderLeftColor: theme.red }]}>
                  {streaming ? (
                    <>
                      <Text style={[styles.answeringLabel, { color: theme.red, fontFamily: theme.sans }]}>
                        {streamContent ? "正在回答" : "正在查找"}
                      </Text>
                      <Text style={[styles.streamStatus, { color: theme.muted, fontFamily: theme.sans }]}>{streamStatus || "正在分析问题…"}</Text>
                      {streamContent ? <Text selectable style={[styles.assistantText, { color: theme.ink, fontFamily: theme.serif }]}>{readableAiText(streamContent)}</Text> : null}
                    </>
                  ) : (
                    <>
                      <Text style={[styles.answeringLabel, { color: theme.red, fontFamily: theme.sans }]}>回答中断</Text>
                      <Text style={[styles.streamStatus, { color: theme.ink, fontFamily: theme.sans }]}>{error}</Text>
                    </>
                  )}
                </View>
              ) : null}
            />
            <View style={styles.composerFooter}>{renderComposer(false)}</View>
          </>
        )}
      </KeyboardAvoidingView>

      <Sheet visible={historyOpen} title="历史对话" onClose={() => setHistoryOpen(false)}>
        <View style={styles.sheetContent}>
          <Pressable disabled={streaming} onPress={() => { startNewConversation(); setHistoryOpen(false); }} style={[styles.sheetAction, { borderBottomColor: theme.ruleDark }]}>
            <Ionicons name="add" size={18} color={theme.red} />
            <Text style={[styles.sheetActionText, { color: theme.red, fontFamily: theme.sans }]}>新对话</Text>
          </Pressable>
          <FlatList
            data={conversations}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={[styles.sheetEmpty, { color: theme.muted, fontFamily: theme.sans }]}>暂无历史记录</Text>}
            renderItem={({ item }) => {
              const active = item.id === conversationId;
              return (
                <View style={[styles.conversationRow, { borderBottomColor: theme.rule, borderLeftColor: active ? theme.red : "transparent" }]}>
                  <Pressable disabled={streaming} onPress={() => openConversation(item)} style={styles.conversationMain}>
                    <Text numberOfLines={1} style={[styles.conversationTitle, { color: active ? theme.red : theme.ink, fontFamily: theme.serif }]}>{item.title}</Text>
                    <Text style={[styles.conversationMeta, { color: theme.muted, fontFamily: theme.sans }]}>{conversationTime(item.lastMessageAt)} · {item.messages.length} 条</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除对话：${item.title}`}
                    disabled={streaming}
                    onPress={() => Alert.alert("删除这条对话？", item.title, [
                      { text: "取消", style: "cancel" },
                      { text: "删除", style: "destructive", onPress: () => {
                        removeConversation(item.id, ownerId);
                        if (item.id === conversationId) startNewConversation();
                      } },
                    ])}
                    style={styles.deleteButton}
                  >
                    <Ionicons name="trash-outline" size={17} color={theme.muted} />
                  </Pressable>
                </View>
              );
            }}
          />
        </View>
      </Sheet>

      <Sheet visible={scopeOpen} title="选择书籍" onClose={() => setScopeOpen(false)}>
        <View style={styles.scopeSheetContent}>
          <Text style={[styles.scopeHelp, { color: theme.muted, fontFamily: theme.sans }]}>不选时查询全部书籍，可以多选。</Text>
          <View style={[styles.scopeSearch, { borderColor: theme.ruleDark }]}>
            <Ionicons name="search-outline" size={16} color={theme.muted} />
            <TextInput
              value={scopeQuery}
              onChangeText={setScopeQuery}
              placeholder="输入书名筛选"
              placeholderTextColor={theme.muted}
              style={[styles.scopeSearchInput, { color: theme.ink, fontFamily: theme.sans }]}
            />
          </View>
          <FlatList
            data={[{ datasetId: "", title: "全部书籍", indexObject: "", type: "book" as const }, ...visibleBooks]}
            keyExtractor={(item) => item.datasetId || "all"}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const selected = item.datasetId ? selectedDatasetIds.includes(item.datasetId) : selectedDatasetIds.length === 0;
              return (
                <Pressable
                  disabled={streaming}
                  onPress={() => {
                    if (!item.datasetId) chooseScope([]);
                    else chooseScope(selected
                      ? selectedDatasetIds.filter((id) => id !== item.datasetId)
                      : [...selectedDatasetIds, item.datasetId]);
                  }}
                  style={[styles.scopeRow, { borderBottomColor: theme.rule, borderLeftColor: selected ? theme.red : "transparent" }]}
                >
                  <View style={[styles.checkbox, { borderColor: selected ? theme.red : theme.ruleDark, backgroundColor: selected ? theme.red : theme.paper }]}>
                    {selected ? <Ionicons name="checkmark" size={11} color={theme.inverse} /> : null}
                  </View>
                  <Text style={[styles.scopeBookTitle, { color: selected ? theme.red : theme.ink, fontFamily: theme.serif }]}>{item.title}</Text>
                </Pressable>
              );
            }}
          />
        </View>
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  historyBar: { minHeight: 42, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyButton: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  newButton: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 4 },
  historyLabel: { fontSize: 11, fontWeight: "900" },
  emptyConversation: { flex: 1, justifyContent: "center", paddingHorizontal: 20, paddingBottom: "12%" },
  emptyComposerWrap: { width: "100%", maxWidth: 760, alignSelf: "center" },
  loadingText: { textAlign: "center", fontSize: 12 },
  composer: { width: "100%", maxWidth: 760, alignSelf: "center", borderWidth: 1 },
  prominentComposer: { borderWidth: 2 },
  composerRow: { minHeight: 68, paddingHorizontal: 13, paddingVertical: 11, flexDirection: "row", alignItems: "flex-end", gap: 10 },
  composerInput: { flex: 1, minHeight: 38, maxHeight: 120, padding: 7, fontSize: 15, lineHeight: 22, textAlignVertical: "top" },
  prominentInput: { minHeight: 58 },
  sendButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  scopeButton: { minHeight: 38, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 5 },
  scopeText: { flex: 1, fontSize: 10, fontWeight: "900" },
  messages: { width: "100%", maxWidth: 830, alignSelf: "center", paddingHorizontal: 18, paddingTop: 26, paddingBottom: 28, gap: 26 },
  userMessage: { maxWidth: "84%", alignSelf: "flex-end", borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 15, paddingVertical: 11 },
  userText: { fontSize: 14, lineHeight: 24 },
  assistantMessage: { maxWidth: 760, borderLeftWidth: 3, paddingLeft: 17, paddingRight: 4 },
  assistantText: { fontSize: 15, lineHeight: 28 },
  answeringLabel: { marginBottom: 7, fontSize: 10, fontWeight: "900" },
  streamStatus: { marginBottom: 10, fontSize: 11, lineHeight: 19 },
  references: { marginTop: 15, gap: 7 },
  reference: { minHeight: 38, borderWidth: StyleSheet.hairlineWidth, justifyContent: "center", paddingHorizontal: 11 },
  referenceText: { fontSize: 10, lineHeight: 17, fontWeight: "900" },
  composerFooter: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 },
  errorBox: { margin: 16, borderWidth: 1, padding: 12 },
  errorText: { fontSize: 11, lineHeight: 18 },
  modalRoot: { flex: 1, flexDirection: "row", justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.22)" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { width: "92%", maxWidth: 440, height: "100%", borderLeftWidth: 1 },
  sheetHeader: { height: 58, borderBottomWidth: 1, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { fontSize: 20, fontWeight: "900" },
  sheetContent: { flex: 1 },
  sheetAction: { minHeight: 50, marginHorizontal: 14, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", gap: 7 },
  sheetActionText: { fontSize: 11, fontWeight: "900" },
  sheetEmpty: { padding: 22, fontSize: 11, textAlign: "center" },
  conversationRow: { minHeight: 66, borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, flexDirection: "row", alignItems: "center" },
  conversationMain: { flex: 1, paddingHorizontal: 14, paddingVertical: 10 },
  conversationTitle: { fontSize: 13, lineHeight: 20, fontWeight: "800" },
  conversationMeta: { marginTop: 3, fontSize: 9 },
  deleteButton: { width: 48, height: 52, alignItems: "center", justifyContent: "center" },
  scopeSheetContent: { flex: 1, padding: 14 },
  scopeHelp: { fontSize: 11, lineHeight: 18 },
  scopeSearch: { height: 44, marginTop: 12, marginBottom: 8, borderWidth: 1, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 7 },
  scopeSearchInput: { flex: 1, height: 42, fontSize: 12 },
  scopeRow: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  checkbox: { width: 16, height: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  scopeBookTitle: { flex: 1, fontSize: 13, lineHeight: 20, fontWeight: "800" },
});
