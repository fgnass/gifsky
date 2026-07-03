// The GIF encode pipeline and the resolution-first target-size search. This is
// the app's heaviest logic; it lives apart from the view and drives the shared
// signals in ../state for progress + status.
import {
	EFFORT_STEPS,
	PASS2_SAFETY,
	PROBE_IMAGE_FRAMES,
	PROBE_SECONDS,
	QUALITY_FLOOR,
	TARGET_FPS,
	TARGET_MAX_RES,
	TARGET_MIN_RES,
	TARGET_QUALITY,
	TARGET_SAFETY,
	effort,
	imageFiles,
	prepared,
	progress,
	releasePrepared,
	settings,
	stage,
	statusText,
	targetOutcome,
	trim,
	video,
} from "../state";
import { encodeGif } from "./encoder";
import { clamp } from "./format";
import { prepareFrames, sampleImageBurst, sampleVideoBurst } from "./frames";
import type { EncodeSettings } from "./types";

/** Full-quality sample + encode at the given settings; returns the GIF bytes. */
export async function encodeWith(s: EncodeSettings): Promise<ArrayBuffer> {
	const source = video.value ? [video.value.file] : imageFiles.value;
	stage.value = "preparing";
	progress.value = 0;
	statusText.value = "Preparing frames…";

	const preparedFrames = await prepareFrames(
		source,
		s,
		(value) => {
			progress.value = value;
		},
		video.value ? trim.value : undefined,
	);

	releasePrepared();
	prepared.value = preparedFrames;
	stage.value = "encoding";
	statusText.value = "Encoding…";

	return encodeGif(
		{
			frames: preparedFrames.frames,
			width: preparedFrames.width,
			height: preparedFrames.height,
			fps: s.fps,
			quality: s.quality,
			repeat: s.repeat,
		},
		() => {},
	);
}

/**
 * Resolution-first target-size mode. fps and quality are held high and fixed
 * (TARGET_FPS / TARGET_QUALITY); the one knob that moves is resolution, since GIF
 * size scales ~with resolution². The flow:
 *
 *  1. Probe the source at the ceiling resolution to project its full size, then
 *     solve res = ceiling · √(cap / projected) for a first guess.
 *  2. Real-encode that guess and Newton-step the resolution onto the cap using
 *     √(aim / measured). The effort dial (EFFORT_STEPS) bounds how many of these
 *     real encodes we spend — more passes land the size closer to the limit.
 *  3. If resolution is pinned at the source ceiling with budget to spare, climb
 *     gifski quality toward 100 (never fps) to spend the leftover headroom.
 *  4. If resolution bottoms out (TARGET_MIN_RES) and it still overflows, drop
 *     quality as a last resort so it at least fits.
 */
export async function encodeToTarget(cap: number): Promise<ArrayBuffer> {
	stage.value = "preparing";
	progress.value = 0;
	targetOutcome.value = null;

	let budget = EFFORT_STEPS[effort.peek()];
	const ceiling = resolutionCeiling();
	const base: EncodeSettings = {
		...settings.peek(),
		fps: TARGET_FPS,
		quality: TARGET_QUALITY,
	};

	// 1 — probe the ceiling and solve for the resolution that should fit the cap.
	statusText.value = "Finding the best fit…";
	const ceilingBytes = await projectFull({ ...base, maxSize: ceiling });
	let res = ceiling;
	if (ceilingBytes > cap * TARGET_SAFETY && ceilingBytes > 0) {
		res = Math.round(ceiling * Math.sqrt((cap * TARGET_SAFETY) / ceilingBytes));
	}
	res = clamp(res, TARGET_MIN_RES, ceiling);

	// 2 — real-encode the guess, then Newton-step the resolution onto the cap.
	let chosen: EncodeSettings = { ...base, maxSize: res };
	settings.value = chosen;
	let gif = await encodeWith(chosen);

	const aim = cap * PASS2_SAFETY;
	while (budget > 0) {
		const overshoot = gif.byteLength > cap;
		const undershoot = gif.byteLength < aim && res < ceiling;
		if (!overshoot && !undershoot) break; // inside the target band — done
		const next = clamp(
			Math.round(res * Math.sqrt(aim / gif.byteLength)),
			TARGET_MIN_RES,
			ceiling,
		);
		if (next === res) break; // pinned at a bound — nothing more to gain here
		res = next;
		chosen = { ...chosen, maxSize: res };
		settings.value = chosen;
		statusText.value = "Dialing in the size…";
		gif = await encodeWith(chosen);
		budget -= 1;
	}

	// 3 — resolution pinned at the source ceiling with room to spare: spend the
	// leftover budget climbing gifski quality (never fps, never a lower quality).
	while (budget > 0 && res >= ceiling && chosen.quality < 100 && gif.byteLength < aim) {
		const q = Math.min(100, chosen.quality + 5);
		const trial: EncodeSettings = { ...chosen, quality: q };
		settings.value = trial;
		statusText.value = "Maximizing quality…";
		const trialGif = await encodeWith(trial);
		budget -= 1;
		if (trialGif.byteLength > cap) {
			settings.value = chosen; // overshoot — keep the last fit
			break;
		}
		chosen = trial;
		gif = trialGif;
	}

	// 4 — resolution bottomed out and it still overflows: drop quality to fit.
	let rescue = 4;
	while (rescue > 0 && gif.byteLength > cap && chosen.quality > QUALITY_FLOOR) {
		const q = Math.max(QUALITY_FLOOR, chosen.quality - 15);
		chosen = { ...chosen, quality: q };
		settings.value = chosen;
		statusText.value = "Fitting your size limit…";
		gif = await encodeWith(chosen);
		rescue -= 1;
	}

	settings.value = chosen;
	targetOutcome.value = {
		cap,
		quality: chosen.quality,
		maxSize: chosen.maxSize,
		fits: gif.byteLength <= cap,
	};
	return gif;
}

/** Resolution ceiling: the ladder top, but never upscaled past the source's own size. */
function resolutionCeiling(): number {
	const src = video.peek();
	if (src) return Math.min(TARGET_MAX_RES, Math.max(src.width, src.height));
	return TARGET_MAX_RES; // images: natural size unknown here; contain() caps it for real
}

/** Probe the given settings and project the burst rate to the whole clip's bytes. */
async function projectFull(s: EncodeSettings): Promise<number> {
	const res = await probeRateFor(s);
	if (!res) return 0;
	return fullBytesFromRate(res.rate, res.kind);
}

/**
 * Encode a short contiguous burst of the actual footage at the given settings
 * and turn it into a per-unit byte rate: bytes/sec for video, bytes/frame for
 * images. The burst matches the real encode's frame density, so the rate scales
 * linearly with duration (or frame count). Returns null when there's no media.
 * This is both the live estimator's oracle and the target-size search's probe.
 */
export async function probeRateFor(
	s: EncodeSettings,
): Promise<{ rate: number; kind: "video" | "images" } | null> {
	const src = video.peek();
	const images = imageFiles.peek();
	if (!src && images.length === 0) return null;

	const burst = src
		? await sampleVideoBurst(src.file, s, trim.peek().start, PROBE_SECONDS)
		: await sampleImageBurst(images, s.maxSize, PROBE_IMAGE_FRAMES);

	const gif = await encodeGif(
		{
			frames: burst.frames,
			width: burst.width,
			height: burst.height,
			fps: s.fps,
			quality: s.quality,
			repeat: 0,
		},
		() => {},
	);

	return src
		? { rate: gif.byteLength / burst.seconds, kind: "video" }
		: { rate: gif.byteLength / burst.count, kind: "images" };
}

/** Project a measured rate to the whole clip: rate × duration (video) or × frame count (images). */
function fullBytesFromRate(rate: number, kind: "video" | "images"): number {
	if (kind === "video") {
		const { start, end } = trim.peek();
		return rate * Math.max(0, end - start);
	}
	return rate * imageFiles.peek().length;
}
