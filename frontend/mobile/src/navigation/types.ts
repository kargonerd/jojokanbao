import type { ArchivePublicationName } from "@jojo/content";
import type { NavigatorScreenParams } from "@react-navigation/native";
import type { MobileBook } from "../lib/books";

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Account: undefined;
  Support: undefined;
  Settings: { section?: SettingsSection } | undefined;
  OpenSourceLicenses: undefined;
  AccountSecurity: undefined;
  Notifications: undefined;
  Bookshelf: undefined;
  Reader: {
    publication: ArchivePublicationName;
    issueId: string;
    page?: number;
    searchQuery?: string;
    searchTitle?: string;
    searchQuote?: string;
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
  Feedback: {
    screen?: string;
    correction?: FeedbackCorrection;
  } | undefined;
};

export type FeedbackCorrection = {
  quote: string;
  contentType: "book" | "periodical" | "times_article";
  contentId?: string;
  contentTitle?: string;
  section?: string;
};

export type SettingsSection = "library" | "reading" | "interaction" | "times" | "data" | "about";

export type MainTabParamList = {
  Today: undefined;
  Library: undefined;
  Search: undefined;
  AI: undefined;
  Times: undefined;
};
