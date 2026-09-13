export interface SpeechArtwork {
  uri: string;
  release: () => void;
}

let artworkSequence = 0;
const MAX_ARTWORK_BASE64_LENGTH = 14 * 1024 * 1024;
const unchanged = (uri: string): SpeechArtwork => ({ uri, release() {} });

/** Android's lock-screen artwork loader accepts URL/file sources, not data URIs. */
export async function materializeSpeechArtwork(uri: string | undefined, scope: string, signal?: AbortSignal): Promise<SpeechArtwork | undefined> {
  if (!uri || signal?.aborted) return undefined;
  let ownedFile: { delete(): void } | undefined;
  const release = () => {
    try { ownedFile?.delete(); } catch { /* Cache cleanup must never affect playback. */ }
    ownedFile = undefined;
  };
  try {
    if (/^https?:\/\//i.test(uri)) {
      const url = new URL(uri);
      return url.hostname ? unchanged(uri) : undefined;
    }
    const data = /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
    if (data && (!data[2] || data[2].length > MAX_ARTWORK_BASE64_LENGTH || data[2].length % 4 !== 0)) return undefined;
    const local = /^file:\/\//i.test(uri);
    const bundled = /^asset:\//i.test(uri) || /^[A-Za-z0-9_]+$/.test(uri);
    if (!data && !local && !bundled) return undefined;
    const { File, Directory, Paths } = await import("expo-file-system");
    if (signal?.aborted) return undefined;
    if (local) {
      const file = new File(uri);
      return file.exists && file.size > 0 ? unchanged(file.uri) : undefined;
    }
    const Crypto = await import("expo-crypto");
    const scopeHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
    if (signal?.aborted) return undefined;
    const directory = new Directory(Paths.cache, "jojo-speech-artwork-v1");
    directory.create({ idempotent: true, intermediates: true });
    const extension = data?.[1].toLowerCase().replace("jpeg", "jpg") ?? "png";
    const file = new File(directory, `${scopeHash}-${Date.now()}-${++artworkSequence}.${extension}`);
    ownedFile = file;
    if (data) file.write(data[2]!, { encoding: "base64" });
    else {
      // resolveAssetSource may return a drawable name for bundled Android logos.
      const { copyAsync } = await import("expo-file-system/legacy");
      if (signal?.aborted) { release(); return undefined; }
      await copyAsync({ from: uri, to: file.uri });
    }
    if (signal?.aborted || !file.exists || file.size === 0) { release(); return undefined; }
    return { uri: file.uri, release };
  } catch {
    release();
    return undefined;
  }
}
