import type { ArchivePublicationName } from "@jojo/content";
import type { NavigatorScreenParams } from "@react-navigation/native";
import type { MobileBook } from "../lib/books";

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Account: undefined;
  Settings: { section?: SettingsSection } | undefined;
  OpenSourceLicenses: undefined;
  AccountSecurity: undefined;
  Notifications: undefined;
  Bookshelf: undefined;
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
