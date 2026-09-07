import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import type { RootStackParamList } from "../navigation/types";
import { resolveMobileBookOpenTarget, type MobileBook, type MobileBookOpenTarget } from "./books";

export function useOpenBook() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [openingBook, setOpeningBook] = useState<MobileBook>();
  const requestRef = useRef<{ book: MobileBook } | undefined>(undefined);

  useFocusEffect(useCallback(() => () => {
    // A slow directory request must not pull the reader back after they leave.
    requestRef.current = undefined;
    setOpeningBook(undefined);
  }, []));

  async function openBook(book: MobileBook) {
    if (requestRef.current?.book.datasetId === book.datasetId) return;
    const request = { book };
    requestRef.current = request;
    setOpeningBook(book);
    let target: MobileBookOpenTarget;
    try {
      target = await resolveMobileBookOpenTarget(book);
    } catch {
      target = { screen: "BookDetails", book };
    }
    if (requestRef.current !== request) return;
    requestRef.current = undefined;
    setOpeningBook(undefined);
    if (target.screen === "BookReader") {
      navigation.navigate("BookReader", {
        datasetId: target.datasetId,
        itemKey: target.itemKey,
        title: target.title,
        bookTitle: target.bookTitle,
      });
    } else {
      navigation.navigate("BookDetails", { book: target.book });
    }
  }

  return { openBook, openingBook };
}
