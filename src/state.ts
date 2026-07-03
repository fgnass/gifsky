import { computed, signal } from "@preact/signals";
import { MAX_VIDEO_FRAMES, releasePreviews } from "./lib/frames";
import type {
	EncodeSettings,
	PreparedFrames,
	Trim,
	VideoInfo,
} from "./lib/types";

export type Stage =
	"idle" | "loading" | "preparing" | "encoding" | "done" | "error";

export const OVERVIEW_COUNT = 18; // thumbnails across the whole clip
export const FINE_COUNT = 12; // thumbnails across the magnified window
export const ZOOM_STEP = 2; // each zoom button press halves/doubles the visible window
export const MIN_VIEW_SECONDS = 1; // tightest window the timeline zooms in to
export const PROBE_SECONDS = 1; // contiguous footage encoded to gauge bytes-per-second
export const PROBE_IMAGE_FRAMES = 8; // frames encoded to gauge bytes-per-frame for image sources
export const PROBE_DEBOUNCE_MS = 280; // wait out rapid setting changes before re-probing

// Target-size mode holds fps and quality high and fixed, then shrinks resolution
// (size ∝ resolution²) until the encode fits the cap — see encodeToTarget. Only if
// the smallest resolution still overflows does quality drop, as a last resort.
export const TARGET_FPS = 15; // frame rate the target search fixes on (never below this)
export const TARGET_QUALITY = 90; // gifski quality the search holds; resolution moves instead
export const TARGET_MAX_RES = 720; // resolution ceiling (also capped to the source's own size)
export const TARGET_MIN_RES = 120; // smallest resolution before quality is sacrificed
export const QUALITY_FLOOR = 1; // absolute quality floor (feasibility probe + last-ditch rescue)
export const TARGET_SAFETY = 0.93; // pass-1 margin: aim under the cap, probe→full carries error
export const PASS2_SAFETY = 0.98; // pass-2 margin: calibrated, so we can aim much closer

// Effort dial: how many real encodes the search spends dialing resolution onto the
// cap. More passes land closer to the limit (more resolution kept) but take longer.
export type Effort = "fast" | "balanced" | "best";
export const EFFORT_STEPS: Record<Effort, number> = {
	fast: 1,
	balanced: 3,
	best: 6,
};

export const FIT_HORIZON_SAFETY = 0.95; // margin for the "longest clip that fits" feasibility limit
export const TARGET_PRESETS = [2, 5, 10]; // quick-pick caps, MB
export const MB = 1000 * 1000; // decimal MB, matching how Finder/iOS report file sizes

export const video = signal<VideoInfo | null>(null);
export const imageFiles = signal<File[]>([]);
export const filmstrip = signal<string[]>([]); // currently displayed thumbnails
export const stripRange = signal<Trim>({ start: 0, end: 0 }); // time window the thumbnails cover
export const trim = signal<Trim>({ start: 0, end: 0 });
export const view = signal<Trim>({ start: 0, end: 0 }); // visible window of the timeline (magnified while grabbing)
export const activeEdge = signal<null | "start" | "end">(null);
export const playing = signal(false);
export const playhead = signal(0);

export const prepared = signal<PreparedFrames | null>(null);
export const outputUrl = signal<string | null>(null);
export const outputSize = signal<number>(0);
export const stage = signal<Stage>("idle");
export const progress = signal(0);
export const statusText = signal("");
export const errorText = signal("");
export const settings = signal<EncodeSettings>({
	fps: 15,
	quality: 85,
	maxSize: 480,
	repeat: 0,
});

// Size estimate (approach B): encode a short probe to learn this clip's real
// compressibility, store it as a per-unit rate, then scale by the live duration
// so trim changes update the figure instantly without re-encoding.
export const probeRate = signal<number | null>(null); // bytes/sec for video, bytes/frame for images
export const probeKind = signal<null | "video" | "images">(null);
export const estimating = signal(false);

// Target-size mode: shrink resolution under a byte cap (see runEncode/encodeToTarget).
export const targetMode = signal(false);
export const targetBytes = signal<number>(5 * MB);
export const effort = signal<Effort>("balanced");
export const targetOutcome = signal<{
	cap: number;
	quality: number;
	maxSize: number;
	fits: boolean;
} | null>(null);

// Feasibility horizon (target mode only). Under a byte cap a clip can be too long
// two ways: too many frames for the memory/time budget (MAX_VIDEO_FRAMES / fps), or
// too many bytes for the cap (cap / bytes-per-sec floor at the smallest size +
// lowest quality). The binding limit is the smaller of the two; past it the clip
// must be trimmed or its fps lowered rather than silently downsampled. In quality
// mode there's no cap, so an over-long clip just samples down to the frame budget.
export const floorRate = signal<number | null>(null); // bytes/sec at the size floor (video only)

export const selectionSeconds = computed(() => {
	const { start, end } = trim.value;
	return Math.max(0, end - start);
});

// Longest selection (seconds) that fits both budgets. Target mode fixes fps at
// TARGET_FPS, so there's no fps to vary here: the limit is the smaller of the frame
// budget (MAX_VIDEO_FRAMES / fps) and the size budget (cap ÷ the measured floor rate).
export const fitLimitSeconds = computed<number>(() => {
	if (!video.value || !targetMode.value) return Infinity;
	const frameLimit = MAX_VIDEO_FRAMES / TARGET_FPS;
	const rate = floorRate.value;
	const sizeLimit =
		rate != null && rate > 0
			? (targetBytes.value * FIT_HORIZON_SAFETY) / rate
			: Infinity;
	return Math.min(frameLimit, sizeLimit);
});

export const selectionFits = computed(
	() => selectionSeconds.value <= fitLimitSeconds.value,
);

// Which budget is binding when the selection doesn't fit: "frames" or "size".
export const fitConstraint = computed<null | "frames" | "size">(() => {
	if (!video.value || selectionFits.value) return null;
	const frameLimit = MAX_VIDEO_FRAMES / TARGET_FPS;
	const rate = floorRate.value;
	const sizeLimit =
		targetMode.value && rate
			? (targetBytes.value * FIT_HORIZON_SAFETY) / rate
			: Infinity;
	return sizeLimit < frameLimit ? "size" : "frames";
});

export const hasMedia = computed(
	() => Boolean(video.value) || imageFiles.value.length > 0,
);
export const estimatedBytes = computed(() => {
	const rate = probeRate.value;
	if (rate == null) return null;
	if (probeKind.value === "video") {
		const { start, end } = trim.value;
		return rate * Math.max(0, end - start);
	}
	return rate * imageFiles.value.length;
});
export const isBusy = computed(
	() =>
		stage.value === "loading" ||
		stage.value === "preparing" ||
		stage.value === "encoding",
);
export const canEncode = computed(
	() => hasMedia.value && !isBusy.value && stage.value !== "done",
);

/* ---------------- PWA install ---------------- */

// The browser's deferred install prompt, stashed from `beforeinstallprompt` so we
// can raise the native dialog on our own terms. Null where it can't be installed
// this way (iOS Safari) and once the app is installed or the prompt is consumed.
export interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const installEvent = signal<BeforeInstallPromptEvent | null>(null);
export const canInstall = computed(() => installEvent.value !== null);

// Whether the install nudge is on screen. Raised only after a real win (a
// finished GIF or a download), never on load.
export const installOpen = signal(false);

/** Free the previously prepared frames' preview URLs and clear the signal. */
export function releasePrepared() {
	if (prepared.value) releasePreviews(prepared.value.previews);
	prepared.value = null;
}
