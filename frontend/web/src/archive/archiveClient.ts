import {
  ARCHIVE_CDN_ORIGIN, JoxClient, ResourceCache, browserContentCache,
} from "@jojo/content";

/** Shared Delivery client; magazine issue pickers and the PDF loader reuse its cache. */
export const archiveClient = new JoxClient(
  import.meta.env.VITE_CONTENT_CDN_BASE || ARCHIVE_CDN_ORIGIN,
  (input, init) => fetch(input, init),
  new ResourceCache(browserContentCache()),
);
