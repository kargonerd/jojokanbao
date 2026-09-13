import type { JojoContentAccess, JojoPublicationStatus } from "./types";

export type LibrarySourceId = "jojo" | "community";

export const LIBRARY_SOURCES = [
  { id: "jojo", title: "JOJO书库", description: "JOJO 整理收录的书籍。" },
  { id: "community", title: "共享书库", description: "书友分享的电子书，开启后需登录阅读。" },
] as const;
export const DEFAULT_LIBRARY_SOURCES: readonly LibrarySourceId[] = ["jojo"];

export interface LibraryBookPolicy {
  librarySource?: LibrarySourceId;
  access?: JojoContentAccess;
  publicationStatus?: JojoPublicationStatus;
}

/** Missing source metadata is the legacy JOJO collection; unknown IDs stay hidden. */
export function isLibrarySourceEnabled(source: string | undefined, enabled: readonly string[] = DEFAULT_LIBRARY_SOURCES): boolean {
  return LIBRARY_SOURCES.some(({ id }) => id === (source ?? "jojo") && enabled.includes(id));
}

/** Restrictions on a parent cannot be relaxed by an item or an old cached manifest. */
export function libraryBookPolicy(...levels: (LibraryBookPolicy | undefined)[]): LibraryBookPolicy {
  return {
    librarySource: levels.find((level) => level?.librarySource === "community")?.librarySource
      ?? levels.find((level) => level?.librarySource)?.librarySource ?? "jojo",
    access: levels.some((level) => level?.access === "authenticated" || level?.librarySource === "community") ? "authenticated" : "public",
    publicationStatus: levels.some((level) => level?.publicationStatus === "draft") ? "draft" : "published",
  };
}

export function isLibraryBookVisible(book: LibraryBookPolicy, signedIn: boolean, enabled: readonly string[] = DEFAULT_LIBRARY_SOURCES): boolean {
  const policy = libraryBookPolicy(book);
  return policy.publicationStatus !== "draft"
    && isLibrarySourceEnabled(policy.librarySource, enabled)
    && (policy.access !== "authenticated" || signedIn);
}
