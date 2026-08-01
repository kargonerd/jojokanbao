import { PUBLICATIONS, type PublicationName } from "./archive/publications";

export const ARCHIVE_ROOT = "/archive";

export function archivePath(...segments: string[]): string {
  return [ARCHIVE_ROOT, ...segments.filter(Boolean)].join("/");
}

export function archiveIssuePath(publication: PublicationName, issue: string): string {
  return archivePath(publication, issue);
}

export function defaultArchiveIssuePath(publication: PublicationName): string {
  return archiveIssuePath(publication, PUBLICATIONS[publication].defaultId);
}
