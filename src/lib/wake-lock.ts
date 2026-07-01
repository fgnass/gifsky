// Keep the screen awake while a GIF is encoding. The browser releases a screen
// wake lock whenever the tab is backgrounded (or the phone locks), so we can't
// just hold one for the duration — we re-acquire it every time the page becomes
// visible again, and drop the whole thing once encoding is done.
//
// This only prevents the *automatic* screen dim/lock while the tab is in the
// foreground; it can't stop a manual lock or an OS tab eviction. Widely available
// on Android Chrome and Safari 16.4+; a no-op where the API is missing.

let sentinel: WakeLockSentinel | null = null;
let active = false;

async function acquire() {
	if (!active || sentinel) return;
	if (!("wakeLock" in navigator)) return;
	try {
		sentinel = await navigator.wakeLock.request("screen");
		// The system can revoke it (e.g. on backgrounding); forget it so the next
		// visibility change re-acquires cleanly.
		sentinel.addEventListener("release", () => {
			sentinel = null;
		});
	} catch {
		// Denied or unsupported (low battery, no user activation) — encoding still
		// runs, the screen just isn't held awake.
	}
}

function onVisibility() {
	if (document.visibilityState === "visible") void acquire();
}

/** Hold a screen wake lock until the returned function is called. */
export function keepAwake(): () => void {
	if (active) return () => {};
	active = true;
	document.addEventListener("visibilitychange", onVisibility);
	void acquire();

	return () => {
		active = false;
		document.removeEventListener("visibilitychange", onVisibility);
		sentinel?.release().catch(() => {});
		sentinel = null;
	};
}
