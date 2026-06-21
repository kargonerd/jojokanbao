import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { fetchJson } from "../lib/api";

type ScrapbookItem = {
  id: string;
  reason: string;
  score: number;
  relatedNews: { id: string; title: string };
};

type Highlight = {
  id: string;
  text: string;
  displayName?: string | null;
};

type Comment = {
  id: string;
  content: string;
  highlightId?: string;
  highlight?: { id: string };
  displayName?: string | null;
};

type NewsDetailData = {
  news: { id: string; title: string; summary?: string | null; content: string; source?: { name: string } | null };
  scrapbookItems: ScrapbookItem[];
  highlights: Highlight[];
  comments: Comment[];
};

type Briefing = {
  tldr: string;
  keyPoints: string[];
  readingQuestions: string[];
  oldContext: { id: string; title: string; reason: string; score: number }[];
};

function getUserIdentity() {
  const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
  const displayName = `路人${Math.floor(Math.random() * 9000 + 1000)}`;
  return { userId, displayName };
}

function getCommentHighlightId(comment: Comment) {
  return comment.highlightId || comment.highlight?.id;
}

export default function NewsDetail({ route, navigation }: any) {
  const { id } = route.params;
  const [data, setData] = useState<NewsDetailData | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const user = useMemo(() => getUserIdentity(), []);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [detailData, briefingData] = await Promise.all([
          fetchJson<NewsDetailData>(`/news/${id}`),
          fetchJson<Briefing>(`/ai/briefing/${id}`).catch(() => null),
        ]);
        if (!mounted) return;
        setData(detailData);
        setBriefing(briefingData);
      } catch {
        if (mounted) setError("未找到新闻或 API 不可用");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [id]);

  async function createHighlight() {
    if (!selectedText.trim() || !data) return;
    const created = await fetchJson<Highlight>("/highlights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newsId: data.news.id,
        userId: user.userId,
        displayName: user.displayName,
        startOffset: 0,
        endOffset: selectedText.length,
        text: selectedText,
      }),
    });
    setData({ ...data, highlights: [created, ...data.highlights] });
    setSelectedText("");
  }

  async function createComment(highlightId: string) {
    if (!commentDrafts[highlightId]?.trim() || !data) return;
    const created = await fetchJson<Comment>("/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        highlightId,
        userId: user.userId,
        displayName: user.displayName,
        content: commentDrafts[highlightId],
      }),
    });
    setData({ ...data, comments: [created, ...data.comments] });
    setCommentDrafts((current) => ({ ...current, [highlightId]: "" }));
  }

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={palette.red} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.loading}>
        <Text style={styles.error}>{error || "未找到新闻"}</Text>
        <TouchableOpacity style={styles.linkButton} onPress={() => navigation.goBack()}>
          <Text style={styles.linkButtonText}>返回</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>返回</Text>
      </TouchableOpacity>

      <Text style={styles.source}>{data.news.source?.name || "未知来源"}</Text>
      <Text style={styles.title}>{data.news.title}</Text>
      {data.news.summary ? <Text style={styles.summary}>{data.news.summary}</Text> : null}

      {briefing ? (
        <View style={styles.agentPanel}>
          <Text style={styles.kicker}>PI AGENT BRIEFING</Text>
          <Text style={styles.tldr}>{briefing.tldr}</Text>
          {briefing.keyPoints.map((point) => (
            <Text key={point} style={styles.bullet}>
              · {point}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>正文</Text>
        <Text style={styles.content}>{data.news.content}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>继续追问</Text>
        {(briefing?.readingQuestions ?? []).map((question) => (
          <Text key={question} style={styles.question}>
            {question}
          </Text>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>旧闻对照</Text>
        {data.scrapbookItems.length === 0 && (briefing?.oldContext.length ?? 0) === 0 ? (
          <Text style={styles.muted}>暂无旧闻候选。</Text>
        ) : null}
        {data.scrapbookItems.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.cardMeta}>反差评分 {item.score.toFixed(2)}</Text>
            <Text style={styles.cardTitle}>{item.relatedNews.title}</Text>
            <Text style={styles.cardReason}>{item.reason}</Text>
          </View>
        ))}
        {data.scrapbookItems.length === 0
          ? (briefing?.oldContext ?? []).map((item) => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.cardMeta}>候选关联 {item.score.toFixed(2)}</Text>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardReason}>{item.reason}</Text>
              </View>
            ))
          : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>划线评论</Text>
        <TextInput
          style={styles.input}
          placeholder="输入你要划线的原文片段"
          value={selectedText}
          onChangeText={setSelectedText}
        />
        <TouchableOpacity style={styles.button} onPress={createHighlight}>
          <Text style={styles.buttonText}>生成划线</Text>
        </TouchableOpacity>

        {data.highlights.map((highlight) => (
          <View key={highlight.id} style={styles.card}>
            <Text style={styles.cardMeta}>{highlight.displayName || "匿名"}</Text>
            <Text style={styles.cardReason}>{highlight.text}</Text>
            <TextInput
              style={styles.input}
              placeholder="评论…"
              value={commentDrafts[highlight.id] || ""}
              onChangeText={(text) => setCommentDrafts((current) => ({ ...current, [highlight.id]: text }))}
            />
            <TouchableOpacity style={styles.buttonOutline} onPress={() => createComment(highlight.id)}>
              <Text style={styles.buttonOutlineText}>评论</Text>
            </TouchableOpacity>
            {data.comments
              .filter((comment) => getCommentHighlightId(comment) === highlight.id)
              .map((comment) => (
                <Text key={comment.id} style={styles.comment}>
                  {comment.displayName || "匿名"}：{comment.content}
                </Text>
              ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const palette = {
  red: "#8b1a1a",
  redDark: "#651212",
  ink: "#202020",
  muted: "#666666",
  rule: "#d8d8d8",
  paper: "#ffffff",
};

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: palette.paper,
  },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: palette.paper,
  },
  backButton: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: palette.red,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 18,
  },
  backText: {
    color: palette.red,
    fontWeight: "900",
  },
  source: {
    fontSize: 12,
    color: palette.muted,
    fontWeight: "700",
    letterSpacing: 2,
  },
  title: {
    color: palette.ink,
    fontSize: 28,
    fontWeight: "900",
    marginTop: 8,
    lineHeight: 36,
  },
  summary: {
    marginTop: 12,
    color: palette.muted,
    lineHeight: 24,
  },
  agentPanel: {
    marginTop: 22,
    borderWidth: 2,
    borderColor: palette.red,
    padding: 16,
  },
  kicker: {
    color: palette.red,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 3,
  },
  tldr: {
    marginTop: 10,
    color: palette.ink,
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 25,
  },
  bullet: {
    marginTop: 8,
    color: palette.ink,
    lineHeight: 22,
  },
  section: {
    marginTop: 26,
  },
  sectionTitle: {
    borderBottomWidth: 1,
    borderBottomColor: palette.ink,
    paddingBottom: 8,
    color: palette.ink,
    fontSize: 20,
    fontWeight: "900",
  },
  content: {
    marginTop: 14,
    color: palette.ink,
    lineHeight: 26,
  },
  question: {
    marginTop: 10,
    borderLeftWidth: 4,
    borderLeftColor: palette.red,
    paddingLeft: 10,
    color: palette.ink,
    lineHeight: 22,
  },
  card: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: palette.rule,
    padding: 14,
    backgroundColor: palette.paper,
  },
  cardMeta: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
  },
  cardTitle: {
    marginTop: 8,
    color: palette.red,
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 22,
  },
  cardReason: {
    marginTop: 8,
    color: palette.muted,
    lineHeight: 21,
  },
  input: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: palette.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.ink,
    backgroundColor: palette.paper,
  },
  button: {
    marginTop: 10,
    backgroundColor: palette.red,
    paddingVertical: 11,
    alignItems: "center",
  },
  buttonText: {
    color: palette.paper,
    fontWeight: "900",
  },
  buttonOutline: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: palette.red,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonOutlineText: {
    color: palette.red,
    fontWeight: "900",
  },
  comment: {
    marginTop: 10,
    borderLeftWidth: 4,
    borderLeftColor: palette.red,
    paddingLeft: 10,
    color: palette.ink,
    lineHeight: 21,
  },
  muted: {
    marginTop: 12,
    color: palette.muted,
  },
  error: {
    color: palette.red,
    fontWeight: "800",
  },
  linkButton: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: palette.red,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  linkButtonText: {
    color: palette.red,
    fontWeight: "900",
  },
});
