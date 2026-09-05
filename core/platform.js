/**
 * Which of the two builds this is.
 *
 * The app ships as a static site on GitHub Pages and as an Electron shell around the same
 * bundle. Almost nothing needs to know the difference -- the desktop build exists to lift
 * Chromium's File System Access blocklist, and lifting it is done in the main process, so
 * the renderer keeps calling `showDirectoryPicker` exactly as it always has.
 *
 * What is left is the handful of places where the *advice* differs: a folder the web build
 * cannot open is one the desktop build can, and saying so on desktop would be nonsense.
 *
 * `globalThis.__desktop` is set by desktop/preload.cjs through contextBridge and by nothing
 * else, so the web build reads `false` here without any build-time flag. Read once at module
 * load rather than per call: the bridge is installed before any page script runs, so it
 * cannot arrive later, and a constant is what the callers want.
 */
export const isDesktop = Boolean(globalThis.__desktop);

/** The packaged app's version, or null on the web, where there is no such thing. */
export const appVersion = globalThis.__desktop?.appVersion ?? null;
