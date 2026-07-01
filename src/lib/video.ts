import type { VideoInfo } from "./types";

/**
 * Load a video file far enough to know its dimensions and duration. The
 * returned object URL is kept alive for the live loop preview and is the
 * caller's responsibility to revoke.
 */
export async function loadVideoInfo(file: File): Promise<VideoInfo> {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.preload = "metadata";
	video.muted = true;
	video.src = url;

	try {
		await waitForMetadata(video);
		return {
			file,
			url,
			duration: video.duration,
			width: video.videoWidth,
			height: video.videoHeight,
		};
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

export type CancelToken = { cancelled: boolean };

export type FilmstripOptions = {
	from?: number;
	to?: number;
	maxThumb?: number;
	signal?: CancelToken;
};

/**
 * Sample `count` evenly spaced thumbnails across a time window (`from`–`to`, or
 * the whole clip) for the trim filmstrip. Uses its own video element and object
 * URL so it never fights the playing preview for the playhead. Pass a
 * `signal` to abort an in-flight extraction (e.g. when the zoom window changes);
 * any thumbnails created before the abort are revoked so nothing leaks.
 */
export async function extractFilmstrip(
	file: File,
	count: number,
	options: FilmstripOptions = {},
): Promise<string[]> {
	const { maxThumb = 200, signal } = options;
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	video.src = url;

	const urls: string[] = [];

	try {
		await waitForMetadata(video);

		const scale = Math.min(
			1,
			maxThumb / Math.max(video.videoWidth, video.videoHeight),
		);
		const width = Math.max(1, Math.round(video.videoWidth * scale));
		const height = Math.max(1, Math.round(video.videoHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");

		if (!ctx) {
			throw new Error("Canvas rendering is not available in this browser.");
		}

		const duration = video.duration;
		const from = Math.max(0, Math.min(options.from ?? 0, duration));
		const to = Math.max(from, Math.min(options.to ?? duration, duration));
		const span = Math.max(0.0001, to - from);

		for (let index = 0; index < count; index += 1) {
			if (signal?.cancelled) {
				releaseFilmstrip(urls);
				return [];
			}
			const at = from + ((index + 0.5) / count) * span;
			await seek(video, Math.min(duration - 0.05, Math.max(0, at)));
			ctx.drawImage(video, 0, 0, width, height);
			urls.push(await toBlobUrl(canvas));
		}

		return urls;
	} finally {
		URL.revokeObjectURL(url);
		video.removeAttribute("src");
		video.load();
	}
}

export function releaseFilmstrip(urls: string[]) {
	for (const url of urls) {
		URL.revokeObjectURL(url);
	}
}

function waitForMetadata(video: HTMLVideoElement) {
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

function toBlobUrl(canvas: HTMLCanvasElement) {
	return new Promise<string>((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("Could not create a filmstrip thumbnail."));
					return;
				}
				resolve(URL.createObjectURL(blob));
			},
			"image/webp",
			0.7,
		);
	});
}
