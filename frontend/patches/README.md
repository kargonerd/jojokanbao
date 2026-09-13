# Dependency patches

## expo-audio 55.0.18

Listening synthesizes a chapter as several audio sources. Expo Audio exposes each source as a separate system-media timeline and has no previous/next chapter callback. The local patch adds an optional `updateLockScreenPlayback` API and `lockScreenPlaybackRequest` events so the app can publish its chapter timeline and route system controls through the existing listening lifecycle.

Android presents that state through a Media3 player wrapper used only by the existing media session; iOS publishes it through Now Playing and remote commands. The actual audio player and its JavaScript playback status remain scoped to the current source. Players that do not opt in retain the upstream behavior. Clearing the chapter state or deactivating the lock screen removes the custom controls. Metadata changes also clear old artwork and reject stale artwork downloads.

These native capabilities require a new Android/iOS binary. The app checks for the optional method before using it, so OTA updates to older binaries retain their standard system controls and can still receive book artwork. Desktop packaging is unrelated to this patch.

`frontend/mobile/package.json` explicitly lists `expo-audio` in Android and iOS autolinking `buildFromSource`. Keep both entries while this patch is needed: Expo's precompiled native modules otherwise bypass the modified sources. Android regression tests are included in the patch and run with `:expo-audio:testDebugUnitTest` after generating the native project.

Remove this patch when upstream Expo Audio supports an independent chapter timeline with play/pause, previous/next and absolute seek callbacks. When upgrading Expo Audio, review both native implementations and run the mobile lifecycle tests, Android native tests and iOS native build.

## pdfjs-dist 5.7.284

The reader opts into PDF.js `disableAutoFetch` mode so that a linearized PDF can show its first page from the initial and index ranges. Upstream PDF.js still validates the last page during document initialization and eagerly resolves every top-level page reference; for flat page trees this downloads all page ranges before `loadingTask.promise` resolves.

The local patch makes those two behaviors respect `disableAutoFetch`:

- linearized documents skip the eager last-page validation;
- page dictionaries are resolved when their page is requested, rather than all at once.

Non-linearized PDFs retain the last-page validation. Remove this patch once upstream PDF.js provides equivalent demand-loading behavior.
