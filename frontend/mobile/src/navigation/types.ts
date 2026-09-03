import type { ArchivePublicationName } from "@jojo/content";
import type { MobileBook } from "../lib/books";

export type RootStackParamList = {
  Tabs: undefined;
  Account: undefined;
  Settings: { section?: SettingsSection } | undefined;
  AccountSecurity: undefined;
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
  TimesDetail: {
    issueDate: string;
    newsId: string;
  };
};

export type SettingsSection = "reading" | "interaction" | "times" | "data" | "about";

export type MainTabParamList = {
  Today: undefined;
  Library: undefined;
  Search: undefined;
  AI: undefined;
  Times: undefined;
};
