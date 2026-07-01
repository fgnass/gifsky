// The GIF encode pipeline and the resolution-first target-size search. This is
// the app's heaviest logic; it lives apart from the view and drives the shared
// signals in ../state for progress + status.
import {
	MAXSIZE_LADDER,
	PASS2_SAFETY,
	PROBE_IMAGE_FRAMES,
	PROBE_SECONDS,
	QUALITY_FLOOR,
	TARGET_MIN_RES_FRACTION,
	TARGET_SAFETY,
	TARGET_TUNE_QUALITY,
	TARGET_TUNE_STEPS,
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
 * Resolution-first target-size mode. Two passes keep it both safe and tight:
 *
 *  1. Search probes (conservatively, aiming under the cap) for the best
 *     (maxSize, quality), then do the real encode to confirm.
 *  2. Calibrate the probe model from that real encode's measured error and
 *     re-tune against the true cap, so we don't leave quality on the table
 *     (probe under-predicted) or overshoot (probe over-predicted). We only
 *     re-encode if the calibrated pick actually differs.
 *
 * A small blind step-down remains as a last resort if the refined encode still
 * overshoots.
 */
export async function encodeToTarget(cap: number): Promise<ArrayBuffer> {
	stage.value = "preparing";
	progress.value = 0;
	targetOutcome.value = null;
	const onStep = (message: string) => {
		statusText.value = message;
	};

	// Pass 1 — conservative search + confirming encode.
	const pick = await searchForTarget(cap * TARGET_SAFETY, 1, onStep);
	let chosen = pick.settings;
	settings.value = chosen;
	let gif = await encodeWith(chosen);

	// Pass 2 — calibrate from the real bytes and re-tune to use the full budget.
	if (pick.predicted > 0) {
		const calibration = gif.byteLength / pick.predicted; // measured ÷ projected at `chosen`
		const refined = await searchForTarget(
			cap * PASS2_SAFETY,
			calibration,
			onStep,
		);
		if (
			refined.settings.quality !== chosen.quality ||
			refined.settings.maxSize !== chosen.maxSize
		) {
			chosen = refined.settings;
			settings.value = chosen;
			statusText.value = "Maximizing quality…";
			gif = await encodeWith(chosen);
		}
	}

	// Fine-tune against the *real* bytes — the probe model isn't exact and gifski's
	// quality knob is discrete, so the projected pick often leaves budget unused.
	let budget = TARGET_TUNE_STEPS; // cap on extra real encodes

	// If pass 2 overshot, step quality down until it fits.
	while (budget > 0 && gif.byteLength > cap && chosen.quality > QUALITY_FLOOR) {
		chosen = {
			...chosen,
			quality: Math.max(QUALITY_FLOOR, chosen.quality - TARGET_TUNE_QUALITY),
		};
		settings.value = chosen;
		statusText.value = "Fitting your size limit…";
		gif = await encodeWith(chosen);
		budget -= 1;
	}

	// Balanced climb: spend leftover budget on higher gifski quality (fewer palette
	// artefacts), buying it back with a small, continuous resolution trim when it
	// overshoots — size scales ~with maxSize², so aim the trim there directly. Never
	// drop below TARGET_MIN_RES_FRACTION of the chosen resolution; that's the point
	// where the sharpness loss outweighs the quality gain.
	const floorRes = Math.round(chosen.maxSize * TARGET_MIN_RES_FRACTION);
	while (
		budget > 0 &&
		chosen.quality < 100 &&
		gif.byteLength < cap * PASS2_SAFETY
	) {
		const q = Math.min(100, chosen.quality + TARGET_TUNE_QUALITY);
		settings.value = { ...chosen, quality: q };
		statusText.value = "Maximizing quality…";
		let trial = await encodeWith({ ...chosen, quality: q });
		budget -= 1;

		if (trial.byteLength <= cap) {
			chosen = { ...chosen, quality: q }; // fits at full resolution — take it outright
			gif = trial;
			continue;
		}

		// Overshoots: trim resolution to fill the cap at this higher quality.
		const trimmedRes = Math.round(
			chosen.maxSize * Math.sqrt((cap * PASS2_SAFETY) / trial.byteLength),
		);
		if (trimmedRes < floorRes || budget <= 0) {
			settings.value = chosen; // too much resolution to give up — keep the last fit
			break;
		}
		settings.value = { ...chosen, maxSize: trimmedRes, quality: q };
		statusText.value = "Maximizing quality…";
		trial = await encodeWith({ ...chosen, maxSize: trimmedRes, quality: q });
		budget -= 1;
		if (trial.byteLength > cap) {
			settings.value = chosen; // estimate came in high — keep the last safe pick
			break;
		}
		chosen = { ...chosen, maxSize: trimmedRes, quality: q };
		gif = trial;
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

/**
 * Find the largest-resolution / highest-quality settings whose projected size
 * fits under `cap`. Walks the resolution ladder downward only when a rung can't
 * fit even at the quality floor; within the first feasible rung it binary-searches
 * quality. Returns a best-effort (smallest rung, floor quality) result if nothing
 * fits, flagged `fits: false`.
 */
async function searchForTarget(
	target: number,
	calibration: number,
	onStep: (message: string) => void,
): Promise<{ settings: EncodeSettings; predicted: number; fits: boolean }> {
	const base = settings.peek();
	const project = (rate: number, kind: "video" | "images") =>
		fullBytesFromRate(rate, kind) * calibration;
	const ladder = [...new Set([base.maxSize, ...MAXSIZE_LADDER])]
		.filter((rung) => rung <= base.maxSize)
		.sort((a, b) => b - a);

	let fallback: { settings: EncodeSettings; predicted: number } | null = null;

	for (const rung of ladder) {
		onStep("Finding the best fit…");
		const floor = await probeRateFor({
			...base,
			maxSize: rung,
			quality: QUALITY_FLOOR,
		});
		if (!floor) break;
		const floorBytes = project(floor.rate, floor.kind);

		if (floorBytes > target) {
			// Even the floor overflows here — remember it (smallest wins) and shrink.
			fallback = {
				settings: { ...base, maxSize: rung, quality: QUALITY_FLOOR },
				predicted: floorBytes,
			};
			continue;
		}

		// This rung fits at some quality — binary-search the highest that stays under.
		let lo = QUALITY_FLOOR;
		let hi = 100;
		let bestQuality = QUALITY_FLOOR;
		let bestBytes = floorBytes;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			onStep("Balancing quality and size…");
			const res = await probeRateFor({ ...base, maxSize: rung, quality: mid });
			const bytes = res ? project(res.rate, res.kind) : Infinity;
			if (bytes <= target) {
				bestQuality = mid;
				bestBytes = bytes;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return {
			settings: { ...base, maxSize: rung, quality: bestQuality },
			predicted: bestBytes,
			fits: true,
		};
	}

	// Nothing fit, even at the smallest rung's floor — deliver the smallest we can.
	const best = fallback ?? {
		settings: { ...base, quality: QUALITY_FLOOR },
		predicted: 0,
	};
	return { settings: best.settings, predicted: best.predicted, fits: false };
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
