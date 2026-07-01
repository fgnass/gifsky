import type {
	EncodeSettings,
	FramePreview,
	PreparedFrames,
	Trim,
} from "./types";

const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

/**
 * Hard ceiling on frames sampled from a video, to bound memory and encode time
 * (every frame is held as ImageData — ~0.5 MB each at 480p — before transfer to
 * the worker). The UI treats this as a feasibility limit: a clip longer than
 * MAX_VIDEO_FRAMES / fps must be trimmed or have its fps lowered, rather than
 * being silently downsampled into a frame-skipping slideshow.
 */
export const MAX_VIDEO_FRAMES = 240;

export function classifyFiles(files: File[]) {
	const video = files.find((file) => isVideo(file));

	if (video) {
		return { kind: "video" as const, files: [video] };
	}

	return {
		kind: "images" as const,
		files: files.filter((file) => file.type.startsWith("image/")),
	};
}

export async function prepareFrames(
	files: File[],
	settings: Pick<EncodeSettings, "fps" | "maxSize">,
	onProgress: (value: number) => void,
	trim?: Trim,
): Promise<PreparedFrames> {
	const selection = classifyFiles(files);

	if (selection.kind === "video") {
		return prepareVideoFrames(selection.files[0], settings, onProgress, trim);
	}

	if (selection.files.length === 0) {
		throw new Error("Choose image frames or a video file first.");
	}

	return prepareImageFrames(selection.files, settings.maxSize, onProgress);
}

export function releasePreviews(previews: FramePreview[]) {
	for (const preview of previews) {
		URL.revokeObjectURL(preview.url);
	}
}

export type Burst = {
	frames: ImageData[];
	width: number;
	height: number;
	/** Seconds of footage the burst represents (video) — used to derive bytes/sec. */
	seconds: number;
	/** Number of frames in the burst — used to derive bytes/frame for image sources. */
	count: number;
};

/**
 * Sample a short contiguous run of frames for the size estimator. Frame density
 * (frames per second) matches `prepareVideoFrames` exactly so the encoded byte
 * count extrapolates linearly. We keep it lean — no previews, no object URLs —
 * because it runs repeatedly while the user tunes settings.
 */
export async function sampleVideoBurst(
	file: File,
	settings: Pick<EncodeSettings, "fps" | "maxSize">,
	from: number,
	seconds: number,
): Promise<Burst> {
	const video = document.createElement("video");
	const url = URL.createObjectURL(file);
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	video.src = url;

	try {
		await waitForVideoMetadata(video);

		const start = clamp(from, 0, video.duration);
		const span = clamp(seconds, 0.04, Math.max(0.04, video.duration - start));
		const target = contain(
			video.videoWidth,
			video.videoHeight,
			settings.maxSize,
		);
		const canvas = makeCanvas(target.width, target.height);
		const ctx = getContext(canvas);
		const frameCount = Math.min(
			Math.max(2, Math.ceil(span * settings.fps)),
			48,
		);
		const step = span / frameCount;
		const frames: ImageData[] = [];

		for (let index = 0; index < frameCount; index += 1) {
			const at = Math.min(start + span - 0.04, start + index * step);
			await seek(video, Math.max(0, at));
			drawContained(ctx, video, target.width, target.height);
			frames.push(ctx.getImageData(0, 0, target.width, target.height));
		}

		return {
			frames,
			width: target.width,
			height: target.height,
			seconds: span,
			count: frameCount,
		};
	} finally {
		URL.revokeObjectURL(url);
		video.removeAttribute("src");
		video.load();
	}
}

/** Sample the first `count` images at the target size for the estimator. */
export async function sampleImageBurst(
	files: File[],
	maxSize: number,
	count: number,
): Promise<Burst> {
	const ordered = [...files].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { numeric: true }),
	);
	const take = ordered.slice(0, Math.max(1, Math.min(count, ordered.length)));
	const firstBitmap = await createImageBitmap(take[0]);
	const target = contain(firstBitmap.width, firstBitmap.height, maxSize);
	const canvas = makeCanvas(target.width, target.height);
	const ctx = getContext(canvas);
	const frames: ImageData[] = [];

	drawContained(ctx, firstBitmap, target.width, target.height);
	frames.push(ctx.getImageData(0, 0, target.width, target.height));
	firstBitmap.close();

	for (let index = 1; index < take.length; index += 1) {
		const bitmap = await createImageBitmap(take[index]);
		drawContained(ctx, bitmap, target.width, target.height);
		frames.push(ctx.getImageData(0, 0, target.width, target.height));
		bitmap.close();
	}

	return {
		frames,
		width: target.width,
		height: target.height,
		seconds: 0,
		count: take.length,
	};
}

async function prepareImageFrames(
	files: File[],
	maxSize: number,
	onProgress: (value: number) => void,
): Promise<PreparedFrames> {
	const ordered = [...files].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { numeric: true }),
	);
	const firstBitmap = await createImageBitmap(ordered[0]);
	const target = contain(firstBitmap.width, firstBitmap.height, maxSize);
	const canvas = makeCanvas(target.width, target.height);
	const ctx = getContext(canvas);
	const frames: ImageData[] = [];
	const previews: FramePreview[] = [];

	drawContained(ctx, firstBitmap, target.width, target.height);
	frames.push(ctx.getImageData(0, 0, target.width, target.height));
	previews.push(await makePreview(canvas, target.width, target.height));
	firstBitmap.close();
	onProgress(1 / ordered.length);

	for (let index = 1; index < ordered.length; index += 1) {
		const bitmap = await createImageBitmap(ordered[index]);
		drawContained(ctx, bitmap, target.width, target.height);
		frames.push(ctx.getImageData(0, 0, target.width, target.height));

		if (previews.length < 12) {
			previews.push(await makePreview(canvas, target.width, target.height));
		}

		bitmap.close();
		onProgress((index + 1) / ordered.length);
	}

	return {
		kind: "images",
		frames,
		previews,
		width: target.width,
		height: target.height,
		sourceLabel: `${ordered.length} image${ordered.length === 1 ? "" : "s"}`,
	};
}

async function prepareVideoFrames(
	file: File,
	settings: Pick<EncodeSettings, "fps" | "maxSize">,
	onProgress: (value: number) => void,
	trim?: Trim,
): Promise<PreparedFrames> {
	const video = document.createElement("video");
	const url = URL.createObjectURL(file);
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	video.src = url;

	try {
		await waitForVideoMetadata(video);

		const start = clamp(trim?.start ?? 0, 0, video.duration);
		const end = clamp(trim?.end ?? video.duration, start, video.duration);
		const span = Math.max(0.04, end - start);

		const target = contain(
			video.videoWidth,
			video.videoHeight,
			settings.maxSize,
		);
		const canvas = makeCanvas(target.width, target.height);
		const ctx = getContext(canvas);
		const frameCount = Math.min(
			Math.max(2, Math.ceil(span * settings.fps)),
			MAX_VIDEO_FRAMES,
		);
		const step = span / frameCount;
		const frames: ImageData[] = [];
		const previews: FramePreview[] = [];

		for (let index = 0; index < frameCount; index += 1) {
			const at = Math.min(end - 0.04, start + index * step);
			await seek(video, Math.max(0, at));
			drawContained(ctx, video, target.width, target.height);
			frames.push(ctx.getImageData(0, 0, target.width, target.height));

			if (previews.length < 12) {
				previews.push(await makePreview(canvas, target.width, target.height));
			}

			onProgress((index + 1) / frameCount);
		}

		return {
			kind: "video",
			frames,
			previews,
			width: target.width,
			height: target.height,
			sourceLabel: `${file.name} · ${span.toFixed(1)}s · ${frameCount} frames`,
		};
	} finally {
		URL.revokeObjectURL(url);
		video.removeAttribute("src");
		video.load();
	}
}

function isVideo(file: File) {
	if (file.type.startsWith("video/")) {
		return true;
	}

	const ext = file.name.split(".").pop()?.toLowerCase();
	return ext ? videoExtensions.has(ext) : false;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function contain(width: number, height: number, maxSize: number) {
	const scale = Math.min(1, maxSize / Math.max(width, height));

	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function makeCanvas(width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function getContext(canvas: HTMLCanvasElement) {
	const context = canvas.getContext("2d", { willReadFrequently: true });

	if (!context) {
		throw new Error("Canvas rendering is not available in this browser.");
	}

	return context;
}

function drawContained(
	ctx: CanvasRenderingContext2D,
	source: CanvasImageSource,
	width: number,
	height: number,
) {
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "rgba(255, 255, 255, 0)";
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(source, 0, 0, width, height);
}

function waitForVideoMetadata(video: HTMLVideoElement) {
	return new Promise<void>((resolve, reject) => {
		const onLoaded = () => cleanup(resolve);
		const onError = () =>
			cleanup(() => reject(new Error("The video could not be loaded.")));
		const cleanup = (done: () => void) => {
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("error", onError);
			done();
		};

		video.addEventListener("loadedmetadata", onLoaded, { once: true });
		video.addEventListener("error", onError, { once: true });
	});
}

function seek(video: HTMLVideoElement, time: number) {
	return new Promise<void>((resolve, reject) => {
		const onSeeked = () => cleanup(resolve);
		const onError = () =>
			cleanup(() => reject(new Error("The video frame could not be read.")));
		const cleanup = (done: () => void) => {
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onError);
			done();
		};

		video.addEventListener("seeked", onSeeked, { once: true });
		video.addEventListener("error", onError, { once: true });
		video.currentTime = time;
	});
}

function makePreview(canvas: HTMLCanvasElement, width: number, height: number) {
	return new Promise<FramePreview>((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("Could not create a frame preview."));
					return;
				}

				resolve({
					url: URL.createObjectURL(blob),
					width,
					height,
				});
			},
			"image/webp",
			0.72,
		);
	});
}
