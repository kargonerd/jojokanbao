import { Alert } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { safeScrapbookPath, type ScrapbookEntry } from "@jojo/auth";
import { ARCHIVE_PUBLICATION_NAMES, type ArchivePublicationName } from "@jojo/content";
import type { RootStackParamList } from "../navigation/types";

export function openClippingSource(navigation: NativeStackNavigationProp<RootStackParamList, "Scrapbook">, entry: ScrapbookEntry): void {
  const path = safeScrapbookPath(entry.contentUrl);
  if (!path) { Alert.alert("无法打开原文", "这条剪报没有有效的原文地址。"); return; }
  try {
    const url = new URL(path, "https://reader.jojokanbao.cn");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "book" && parts[1] && parts[2]) {
      navigation.navigate("BookReader", { datasetId: parts[1], itemKey: parts[2], title: entry.contentTitle, bookTitle: entry.contentTitle,
        initialChapterId: url.searchParams.get("chapter") || undefined, initialAnchorId: url.searchParams.get("anchor") || undefined,
        initialText: url.searchParams.get("quote") || entry.quote.slice(0, 160) || undefined });
    } else if (parts[0] === "archive" && ARCHIVE_PUBLICATION_NAMES.includes(parts[1] as ArchivePublicationName) && parts[2]) {
      navigation.navigate("Reader", {
        publication: parts[1] as ArchivePublicationName, issueId: parts[2],
        page: Number(url.hash.match(/^#page-(\d+)$/)?.[1]) || 1,
        searchQuery: url.searchParams.get("query") || undefined,
        searchQuote: url.searchParams.get("quote") || entry.quote.slice(0, 160) || undefined,
      });
    } else Alert.alert("无法打开原文", "这条资料的阅读地址暂不支持。");
  } catch { Alert.alert("无法打开原文", "这条剪报的原文地址无效。"); }
}
