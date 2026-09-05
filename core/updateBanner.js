/**
 * "There is a newer version" -- desktop only.
 *
 * The web build updates itself by being reloaded, so there is nothing to say there. A
 * downloaded, unsigned, un-auto-updating binary is the opposite: without this, someone can
 * run a build from a year ago indefinitely and have no way of knowing.
 *
 * Deliberately the whole of the update story. There is no download and no installer here --
 * `electron-updater` effectively requires signed builds, and these are not signed. A banner
 * and a link is what can honestly be offered.
 *
 * The check itself is in the main process (desktop/main.js), which keeps `api.github.com`
 * out of the renderer's CSP and out of the two suites that assert the bundle reaches for
 * nothing remote. This end only ever receives an answer, and only when there is one: a
 * failed check -- offline, rate-limited, an unreadable tag -- never calls back at all, so
 * "not called" is the normal case and not an error to handle.
 */
import { isDesktop } from './platform.js';

/**
 * The version whose banner has been dismissed, if any.
 *
 * Per version rather than per session. The check runs once at launch, so a session-scoped
 * dismissal would put the same banner back on every start until the user updated -- which
 * is nagging, and this is a tool people leave installed for a long time. Dismissing 1.4.0
 * says nothing about 1.5.0, which is the behaviour worth having.
 */
const DISMISSED_KEY = 'SOD_ModMaker_UpdateDismissed';

function show({ version, url }) {
    if (!version || !url) return;
    if (localStorage.getItem(DISMISSED_KEY) === version) return;

    const banner = document.getElementById('update-banner');
    if (!banner) return;

    const link = banner.querySelector('#update-banner-link');
    link.href = url;
    link.textContent = version;

    banner.querySelector('#update-banner-dismiss').addEventListener('click', () => {
        localStorage.setItem(DISMISSED_KEY, version);
        banner.hidden = true;
    }, { once: true });

    banner.hidden = false;
}

/**
 * Subscribe to the answer, if there is going to be one.
 *
 * Called from the shell at startup rather than lazily, because the check is already in
 * flight by the time the window has a page in it -- main.js starts it as the window is
 * created -- and a subscription registered later than the answer arrives would miss it.
 */
export function initUpdateBanner() {
    if (!isDesktop) return;

    // Optional-called rather than called. The shell awaits this on the way to activating a
    // flow, so anything that throws here is not a missing banner -- it is a blank page. A
    // preload that does not offer the subscription should cost the banner and nothing else.
    globalThis.__desktop.onUpdateAvailable?.(show);
}
