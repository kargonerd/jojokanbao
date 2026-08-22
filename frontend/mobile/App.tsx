import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { fetchJson } from "./src/lib/api";
import NewsDetail from "./src/screens/NewsDetail";

const Stack = createNativeStackNavigator();

type NewsItem = {
  id: string;
  title: string;
  summary?: string | null;
  publishedAt: string;
  source?: { name: string } | null;
};

type Digest = {
  articleCount: number;
  hotKeywords: { name: string; weight: number }[];
};

function HomeScreen({ navigation }: any) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [newsData, digestData] = await Promise.all([
          fetchJson<NewsItem[]>("/news?limit=100"),
          fetchJson<Digest>("/ai/digest?limit=100"),
        ]);
        setNews(Array.isArray(newsData) ? newsData : []);
        setDigest(digestData);
      } catch {
        setError("无法连接 JOJO Times API");
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.brand}>JOJO TIMES</Text>
        <Text style={styles.subtitle}>AI 辅助阅读新闻</Text>
      </View>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={palette.red} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.digestPanel}>
            <Text style={styles.kicker}>PI AGENT</Text>
            <Text style={styles.digestTitle}>已读入 {digest?.articleCount ?? news.length} 条新闻</Text>
            <View style={styles.keywordRow}>
              {(digest?.hotKeywords ?? []).slice(0, 6).map((term) => (
                <Text key={term.name} style={styles.tag}>
                  {term.name} / {term.weight}
                </Text>
              ))}
            </View>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {news.map((item, index) => (
            <TouchableOpacity key={item.id} style={styles.card} onPress={() => navigation.navigate("Detail", { id: item.id })}>
              <Text style={styles.index}>#{String(index + 1).padStart(3, "0")} · {item.source?.name || "未知来源"}</Text>
              <Text style={styles.cardTitle}>{item.title}</Text>
              {item.summary ? <Text style={styles.cardSummary}>{item.summary}</Text> : null}
            </TouchableOpacity>
          ))}
          {news.length === 0 && !error ? <Text style={styles.empty}>暂无新闻，请先运行抓取脚本。</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Detail" component={NewsDetail} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const palette = {
  red: "#8b1a1a",
  ink: "#202020",
  muted: "#666666",
  rule: "#d8d8d8",
  paper: "#ffffff",
  soft: "#f7f7f7",
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.paper,
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 2,
    borderBottomColor: palette.ink,
    backgroundColor: palette.paper,
  },
  brand: {
    color: palette.red,
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 3,
  },
  subtitle: {
    marginTop: 6,
    color: palette.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    padding: 20,
    gap: 12,
  },
  digestPanel: {
    borderWidth: 2,
    borderColor: palette.red,
    padding: 16,
    backgroundColor: palette.paper,
  },
  kicker: {
    color: palette.red,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 3,
  },
  digestTitle: {
    marginTop: 8,
    color: palette.ink,
    fontSize: 18,
    fontWeight: "900",
  },
  keywordRow: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tag: {
    borderWidth: 1,
    borderColor: palette.rule,
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: palette.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  card: {
    padding: 16,
    borderWidth: 1,
    borderColor: palette.rule,
    backgroundColor: palette.paper,
  },
  index: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  cardTitle: {
    marginTop: 8,
    color: palette.ink,
    fontSize: 17,
    fontWeight: "800",
    lineHeight: 24,
  },
  cardSummary: {
    marginTop: 8,
    color: palette.muted,
    lineHeight: 21,
  },
  error: {
    borderWidth: 1,
    borderColor: palette.red,
    padding: 12,
    color: palette.red,
    fontWeight: "700",
  },
  empty: {
    textAlign: "center",
    color: palette.muted,
  },
});
