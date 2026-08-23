import type { ArchivePublicationName } from "@jojo/content";
import type { MobileBook } from "../lib/books";

export type RootStackParamList = {
  Tabs: undefined;
  Settings: { section?: SettingsSection } | undefined;
  Reader: {
    publication: ArchivePublicationName;
    issueId: string;
    page?: number;
  };
  BookDetails: {
    book: MobileBook;
  };
  BookReader: {
    datasetId: string;
    itemKey: string;
    title: string;
    bookTitle: string;
    initialChapterId?: string;
    initialAnchorId?: string;
    initialText?: string;
    returnToReference?: boolean;
  };
};

export type SettingsSection = "reading" | "interaction" | "data" | "about";

export type MainTabParamList = {
  Today: undefined;
  Library: undefined;
  Search: undefined;
  Me: undefined;
};
