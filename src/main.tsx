import { registerSW } from "virtual:pwa-register";
import {
	AlertTriangle,
	Download,
	Film,
	FolderOpen,
	Gauge,
	GripHorizontal,
	Loader2,
	Maximize2,
	Pause,
	Play,
	Repeat,
	RotateCcw,
	Scissors,
	SlidersHorizontal,
	Smartphone,
	Sparkles,
	Target,
	ZoomIn,
	ZoomOut,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	Button,
	ButtonLink,
	Chip,
	IconButton,
	Label,
	Panel,
	SegButton,
} from "./components/ui";
import { clamp, formatBytes, timecode, timecodeFrames } from "./lib/format";
import { classifyFiles } from "./lib/frames";
import { encodeToTarget, encodeWith, probeRateFor } from "./lib/target-size";
import type { EncodeSettings, Trim } from "./lib/types";
import type { CancelToken } from "./lib/video";
import { extractFilmstrip, loadVideoInfo, releaseFilmstrip } from "./lib/video";
import { keepAwake } from "./lib/wake-lock";
import {
	activeEdge,
	type BeforeInstallPromptEvent,
	canEncode,
	canInstall,
	estimatedBytes,
	estimating,
	errorText,
	filmstrip,
	FINE_COUNT,
	fitConstraint,
	fitLimitSeconds,
	floorRate,
	fpsFit,
	hasMedia,
	imageFiles,
	installEvent,
	installOpen,
	isBusy,
	MAXSIZE_LADDER,
	MB,
	MIN_VIEW_SECONDS,
	outputSize,
	outputUrl,
	OVERVIEW_COUNT,
	playhead,
	playing,
	prepared,
	PROBE_DEBOUNCE_MS,
	probeKind,
	probeRate,
	progress,
	QUALITY_FLOOR,
	releasePrepared,
	selectionFits,
	settings,
	stage,
	statusText,
	stripRange,
	targetBytes,
	targetMode,
	targetOutcome,
	TARGET_PRESETS,
	trim,
	video,
	view,
	ZOOM_STEP,
} from "./state";
import "./styles.css";

// A live handle to the preview <video> so the trim handles can scrub it.
let previewEl: HTMLVideoElement | null = null;

// Coalesced scrubbing: keep at most one seek in flight and always chase the
// latest requested time, so dragging a handle never floods the decoder (which
// shows black/garbled frames when over-seeked).
let seekPending: number | null = null;
let seekBusy = false;
function scrubPreview(time: number) {
	playhead.value = time;
	const el = previewEl;
	if (!el) return;
	seekPending = time;
	if (seekBusy) return;
	seekBusy = true;
	const step = () => {
		if (!previewEl || seekPending === null) {
			seekBusy = false;
			return;
		}
		const target = seekPending;
		seekPending = null;
		if (Math.abs(target - previewEl.currentTime) < 0.005) {
			seekBusy = false;
			return;
		}
		previewEl.addEventListener("seeked", step, { once: true });
		try {
			previewEl.currentTime = target;
		} catch {
			seekBusy = false;
		}
	};
	step();
}

const prefersReducedMotion = () =>
	typeof matchMedia !== "undefined" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

registerSW({ immediate: true });

/* ---------------- PWA install nudge ---------------- */

const INSTALL_DISMISSED = "gifsky:install-dismissed";

// Already running as an installed app (Android/desktop display-mode, or iOS).
function isStandalone() {
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		(navigator as { standalone?: boolean }).standalone === true
	);
}

// Capture the deferred prompt Chrome fires when the PWA becomes installable, and
// drop it again if the app gets installed (so we stop offering).
window.addEventListener("beforeinstallprompt", (event) => {
	event.preventDefault();
	installEvent.value = event as BeforeInstallPromptEvent;
});
window.addEventListener("appinstalled", () => {
	installEvent.value = null;
	installOpen.value = false;
	try {
		localStorage.removeItem(INSTALL_DISMISSED);
	} catch {
		// private mode / storage disabled — nothing to clean up
	}
});

// Raise the nudge after a clear win, unless already installed, previously
// dismissed, or the browser offers no programmatic install (iOS Safari).
function offerInstall() {
	if (!canInstall.value || isStandalone()) return;
	try {
		if (localStorage.getItem(INSTALL_DISMISSED)) return;
	} catch {
		// storage unavailable — fall through and offer anyway
	}
	installOpen.value = true;
}

async function acceptInstall() {
	const event = installEvent.value;
	if (!event) return;
	installOpen.value = false;
	try {
		await event.prompt();
		await event.userChoice;
	} catch {
		// the user gesture expired or the prompt failed — nothing to recover
	}
	// The deferred prompt is single-use; drop it so canInstall reflects reality.
	installEvent.value = null;
}

function dismissInstall() {
	installOpen.value = false;
	try {
		localStorage.setItem(INSTALL_DISMISSED, "1");
	} catch {
		// storage unavailable — it'll simply offer again next win
	}
}

function App() {
	return (
		<main class="relative min-h-dvh overflow-hidden bg-sky text-star">
			<div class="starfield pointer-events-none fixed inset-0 opacity-70" />
			<div class="relative mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]">
				<div class="flex flex-1 flex-col gap-4 pt-4">
					{hasMedia.value || stage.value === "done" ? (
						<Workspace />
					) : (
						<DropZone />
					)}
				</div>
				<ActionBar />
			</div>
		</main>
	);
}

function DropZone() {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);

	return (
		<button
			type="button"
			class={`group flex flex-1 flex-col items-center justify-center gap-5 rounded-panel border-2 border-dashed p-8 text-center transition ${
				dragging ? "border-sun bg-sun/10" : "border-sky-line bg-sky-soft/50"
			}`}
			onClick={() => inputRef.current?.click()}
			onDragOver={(event) => {
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				void selectFiles(event.dataTransfer?.files ?? null);
			}}
		>
			<img
				src="/icon-192.png"
				alt=""
				class="size-24 rounded-3xl shadow-pop transition group-hover:-translate-y-1"
			/>
			<div class="max-w-xs">
				<h1 class="display text-3xl text-star">Gifsky</h1>
				<p class="mt-1 text-[0.7rem] font-semibold tracking-[0.18em] text-star-soft uppercase">
					Trim · Loop · Encode
				</p>
				<p class="mt-4 text-sm leading-6 text-star-soft">
					Drop a video or tap to pick a clip, then trim it down and preview the
					loop before you export. Everything stays on your device.
				</p>
			</div>
			<span class="inline-flex items-center gap-2 rounded-full bg-sky-deep/60 px-4 py-2 text-xs font-bold tracking-wide text-star-soft uppercase">
				<Sparkles class="size-3.5 text-sun" />
				100% offline
			</span>
			<input
				ref={inputRef}
				class="sr-only"
				type="file"
				accept={FILE_ACCEPT}
				multiple
				onChange={(event) => void selectFiles(event.currentTarget.files)}
			/>
		</button>
	);
}

function Workspace() {
	return (
		<>
			<PreviewStage />
			{stage.value !== "done" && video.value ? <TrimBar /> : null}
			{stage.value !== "done" ? (
				<SettingsCard />
			) : (
				<>
					<ResultCard />
					<InstallCard />
				</>
			)}
		</>
	);
}

// Post-conversion nudge to install the PWA. Renders only when the browser has a
// deferred prompt for us and the user hasn't dismissed or installed it.
function InstallCard() {
	if (!installOpen.value || !canInstall.value) return null;
	return (
		<Panel tone="result" class="p-4">
			<div class="flex items-center gap-3">
				<div class="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-lilac/15 text-lilac">
					<Smartphone class="size-5" />
				</div>
				<div class="min-w-0 flex-1">
					<p class="display text-base text-lilac">Install Gifsky</p>
					<p class="mt-0.5 text-xs leading-snug text-star-soft">
						Add it to your home screen for one-tap, fully offline encoding.
					</p>
				</div>
			</div>
			<div class="mt-3 flex items-center gap-2">
				<Button
					tone="lilac"
					shape="control"
					class="flex-1"
					onClick={() => void acceptInstall()}
				>
					<Download class="size-4" />
					Install
				</Button>
				<Button
					tone="ghost"
					shape="control"
					class="shrink-0 whitespace-nowrap"
					onClick={dismissInstall}
				>
					Not now
				</Button>
			</div>
		</Panel>
	);
}

function PreviewStage() {
	const ref = useRef<HTMLVideoElement>(null);
	const src = video.value;
	const result = outputUrl.value;
	const showResult = stage.value === "done" && result;

	// Keep the module-level handle pointed at the live element.
	useEffect(() => {
		previewEl = ref.current;
		return () => {
			if (previewEl === ref.current) previewEl = null;
		};
	});

	// Load the source and wire loop enforcement once per clip.
	useEffect(() => {
		const el = ref.current;
		if (!el || !src) return;

		el.src = src.url;
		el.currentTime = trim.peek().start;

		const onTime = () => {
			// Only loop-correct during playback. While paused (scrubbing the trim
			// handles) the playhead is driven manually — correcting here would yank
			// currentTime back to `start` on every seek and flicker the frame.
			if (!playing.peek()) return;
			const t = el.currentTime;
			playhead.value = t;
			const { start, end } = trim.peek();
			if (t >= end - 0.02 || t < start - 0.05) {
				el.currentTime = start;
			}
		};
		const onEnded = () => {
			el.currentTime = trim.peek().start;
			if (playing.peek()) void el.play();
		};

		el.addEventListener("timeupdate", onTime);
		el.addEventListener("ended", onEnded);

		return () => {
			el.removeEventListener("timeupdate", onTime);
			el.removeEventListener("ended", onEnded);
		};
	}, [src?.url]);

	// Drive play/pause from the `playing` signal so the loop auto-starts on load
	// and stays in sync with the toggle.
	useEffect(() => {
		const el = ref.current;
		if (!el || !src) return;

		if (playing.value) {
			const { start, end } = trim.peek();
			if (el.currentTime < start || el.currentTime >= end - 0.02) {
				el.currentTime = start;
			}
			el.play().catch(() => {
				playing.value = false;
			});
		} else {
			el.pause();
		}
	}, [playing.value, src?.url]);

	return (
		<Panel as="div" tone="stage" class="relative">
			<div class="checkerboard grid max-h-[46dvh] min-h-48 place-items-center p-3">
				{showResult ? (
					<img
						src={result}
						alt="Encoded GIF, looping"
						class="max-h-[42dvh] max-w-full rounded-[20px] object-contain"
					/>
				) : src ? (
					<video
						ref={ref}
						class="max-h-[42dvh] max-w-full rounded-[20px] object-contain"
						muted
						playsInline
						preload="auto"
						onClick={togglePlay}
					/>
				) : (
					<div class="flex flex-col items-center gap-3 p-8 text-center text-star-soft">
						<Film class="size-10 text-sun" />
						<p class="text-sm">
							{imageFiles.value.length} frames ready to encode
						</p>
					</div>
				)}
			</div>

			<span class="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-sky-deep/80 px-3 py-1 text-[0.65rem] font-bold tracking-wide text-lilac uppercase backdrop-blur">
				<Repeat class="size-3" />
				{showResult ? "GIF" : "Loop"}
			</span>

			{!showResult && src ? (
				<button
					type="button"
					onClick={togglePlay}
					aria-label={playing.value ? "Pause preview" : "Play preview"}
					class="pop absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-sun text-sky-deep"
					style={{
						opacity: playing.value ? 0 : 1,
						pointerEvents: playing.value ? "none" : "auto",
					}}
				>
					<Play class="size-7" fill="currentColor" />
				</button>
			) : null}

			{!showResult && src && playing.value ? (
				<button
					type="button"
					onClick={togglePlay}
					aria-label="Pause preview"
					class="absolute right-3 bottom-3 flex size-10 items-center justify-center rounded-full bg-sky-deep/80 text-star backdrop-blur transition hover:text-sun"
				>
					<Pause class="size-4" fill="currentColor" />
				</button>
			) : null}
		</Panel>
	);
}

function TrimBar() {
	const trackRef = useRef<HTMLDivElement>(null);
	const src = video.value!;
	const { start, end } = trim.value;
	const v = view.value;
	const sr = stripRange.value;
	const duration = src.duration || 1;
	const viewLen = Math.max(1e-3, v.end - v.start);
	const active = activeEdge.value;
	const zoomLevel = duration / viewLen;
	const minView = Math.min(duration, MIN_VIEW_SECONDS);
	const canZoomIn = viewLen > minView + 1e-3;
	const canZoomOut = viewLen < duration - 1e-3;

	const vpn = (t: number) => clamp(((t - v.start) / viewLen) * 100, 0, 100);

	// Grab a trim edge and drag it at the current zoom. Dragging is relative (the
	// handle follows the cursor from the grab point) so changing scale never makes
	// it jump; when zoomed in, the window grows outward to keep the handle in view.
	const beginEdge = (edge: "start" | "end") => (event: PointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const track = trackRef.current;
		if (!track) return;
		const el = event.currentTarget as Element;
		try {
			el.setPointerCapture(event.pointerId);
		} catch {
			// capture is a nicety
		}
		if (playing.peek()) playing.value = false;

		const grabX = event.clientX;
		const grabTime = edge === "start" ? trim.peek().start : trim.peek().end;
		activeEdge.value = edge;
		scrubPreview(grabTime);

		const move = (moveEvent: PointerEvent) => {
			const cur = view.peek();
			const curLen = cur.end - cur.start;
			const rect = track.getBoundingClientRect();
			const deltaTime = ((moveEvent.clientX - grabX) / rect.width) * curLen;
			const target = grabTime + deltaTime;
			const t = trim.peek();
			const min = minClipLen();

			const edgeTime =
				edge === "start"
					? clamp(target, 0, t.end - min)
					: clamp(target, t.start + min, duration);
			trim.value =
				edge === "start" ? { ...t, start: edgeTime } : { ...t, end: edgeTime };
			scrubPreview(edgeTime);

			// When zoomed in, grow the window outward so the handle stays visible.
			if (curLen < duration - 0.01) {
				const pad = curLen * 0.12;
				let ns = cur.start;
				let ne = cur.end;
				if (edgeTime > cur.end - pad) ne = Math.min(duration, edgeTime + pad);
				if (edgeTime < cur.start + pad) ns = Math.max(0, edgeTime - pad);
				if (ns !== cur.start || ne !== cur.end) {
					view.value = { start: ns, end: ne };
					scheduleFine(ns, ne);
				}
			}
		};

		const up = (upEvent: PointerEvent) => {
			try {
				el.releasePointerCapture(upEvent.pointerId);
			} catch {
				// ignore
			}
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			activeEdge.value = null;
		};

		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// Move the whole selection, or scrub the playhead. The selection tracks the
	// pointer within the current window; when zoomed in and the pointer reaches an
	// edge it keeps scrolling continuously (rAF loop) so it can cross the whole clip.
	const beginFlat = (mode: "move" | "scrub") => (event: PointerEvent) => {
		event.preventDefault();
		if (mode === "move") event.stopPropagation();
		const track = trackRef.current;
		if (!track) return;
		const el = event.currentTarget as Element;
		try {
			el.setPointerCapture(event.pointerId);
		} catch {
			// ignore
		}
		if (playing.peek()) playing.value = false;

		const len = trim.peek().end - trim.peek().start;
		let pointerX = event.clientX;

		// Time under the pointer, mapped into the given window.
		const pointerTime = (v: Trim) => {
			const rect = track.getBoundingClientRect();
			return (
				v.start +
				clamp((pointerX - rect.left) / rect.width, 0, 1) * (v.end - v.start)
			);
		};
		// Offset between pointer and selection start at grab, so the selection doesn't jump.
		const grabOffset =
			mode === "move" ? pointerTime(view.peek()) - trim.peek().start : 0;

		const apply = () => {
			const cur = view.peek();
			if (mode === "move") {
				const ns = clamp(pointerTime(cur) - grabOffset, 0, duration - len);
				trim.value = { start: ns, end: ns + len };
				scrubPreview(ns);
			} else {
				scrubPreview(pointerTime(cur));
			}
		};

		// Continuous edge autoscroll: while the pointer sits in the edge zone (move
		// mode, zoomed in), pan the window every frame and let the selection follow.
		const EDGE_PX = 32; // distance from an edge that starts scrolling
		let raf = 0;
		const tick = () => {
			raf = 0;
			const cur = view.peek();
			const curLen = cur.end - cur.start;
			if (mode !== "move" || curLen >= duration - 0.01) return;
			const rect = track.getBoundingClientRect();
			const overRight = pointerX - (rect.right - EDGE_PX);
			const overLeft = rect.left + EDGE_PX - pointerX;
			let dir = 0;
			let depth = 0;
			if (overRight > 0) {
				dir = 1;
				depth = clamp(overRight / EDGE_PX, 0, 1);
			} else if (overLeft > 0) {
				dir = -1;
				depth = clamp(overLeft / EDGE_PX, 0, 1);
			}
			if (dir === 0) return; // pointer left the edge zone — stop
			const step = curLen * 0.012 * depth * dir; // up to ~0.7× of the window per second
			const vs = clamp(cur.start + step, 0, duration - curLen);
			if (vs !== cur.start) {
				view.value = { start: vs, end: vs + curLen };
				scheduleFine(vs, vs + curLen);
			}
			apply();
			raf = requestAnimationFrame(tick);
		};

		const move = (moveEvent: PointerEvent) => {
			pointerX = moveEvent.clientX;
			apply();
			if (mode === "move" && !raf) raf = requestAnimationFrame(tick);
		};
		const up = (upEvent: PointerEvent) => {
			if (raf) cancelAnimationFrame(raf);
			try {
				el.releasePointerCapture(upEvent.pointerId);
			} catch {
				// ignore
			}
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		apply();
	};

	const stripSpan = Math.max(1e-3, sr.end - sr.start);
	const thumbCount = filmstrip.value.length || 1;
	const selLeft = vpn(start);
	const selRight = vpn(end);
	const tipFrac = active === "start" ? selLeft : selRight;

	// Feasibility horizon: everything past start + fitLimitSeconds is too long for
	// the cap (target mode) or the frame budget (both modes).
	const fitLimit = fitLimitSeconds.value;
	const horizonTime = Number.isFinite(fitLimit) ? start + fitLimit : null;
	const showHorizon =
		horizonTime != null &&
		horizonTime < duration - 1e-3 &&
		horizonTime < v.end - 1e-3;
	const horizonPct = horizonTime != null ? vpn(horizonTime) : 0;

	return (
		<Panel class="p-4">
			<div class="mb-3 flex items-center justify-between">
				<span class="flex items-center gap-2 text-xs font-bold tracking-[0.18em] text-star-soft uppercase">
					<Scissors class="size-4 text-sun" />
					Trim
				</span>
				<div class="flex items-center gap-2">
					{zoomLevel > 1.05 ? (
						<span class="text-[0.7rem] font-bold text-sun tabular-nums">
							{zoomLevel.toFixed(1)}×
						</span>
					) : null}
					<div class="flex items-center gap-1">
						<ZoomButton
							label="Zoom out"
							disabled={!canZoomOut}
							onClick={() => zoomView(1 / ZOOM_STEP)}
						>
							<ZoomOut class="size-3.5" />
						</ZoomButton>
						<ZoomButton
							label="Zoom in"
							disabled={!canZoomIn}
							onClick={() => zoomView(ZOOM_STEP)}
						>
							<ZoomIn class="size-3.5" />
						</ZoomButton>
					</div>
				</div>
			</div>

			{/* relative wrapper lets the timecode tooltip sit above the clipped track */}
			<div class="relative">
				{active ? (
					<div
						class="pointer-events-none absolute -top-1 z-20 -translate-x-1/2 -translate-y-full rounded-md bg-sun px-2 py-0.5 text-xs font-bold text-sky-deep tabular-nums shadow-press"
						style={{ left: `${tipFrac}%` }}
					>
						{timecodeFrames(
							active === "start" ? start : end,
							settings.value.fps,
						)}
					</div>
				) : null}

				<div
					ref={trackRef}
					class="relative h-20 touch-none rounded-2xl border-2 border-sky-line bg-sky-deep select-none"
					onPointerDown={beginFlat("scrub")}
				>
					{/* Clipped visual layer: the filmstrip, dimming and horizon are rounded
					    to the track shape, while the handles and grip below sit on top and
					    may overhang the edges without being cut off. */}
					<div class="pointer-events-none absolute inset-0 overflow-hidden rounded-[14px]">
						{filmstrip.value.map((url, index) => {
							const t0 = sr.start + (index / thumbCount) * stripSpan;
							const t1 = sr.start + ((index + 1) / thumbCount) * stripSpan;
							const left = ((t0 - v.start) / viewLen) * 100;
							const width = ((t1 - t0) / viewLen) * 100;
							return (
								<img
									key={index}
									src={url}
									alt=""
									draggable={false}
									class="pointer-events-none absolute inset-y-0 h-full object-cover"
									style={{ left: `${left}%`, width: `${width}%` }}
								/>
							);
						})}

						{/* dim everything outside the selection */}
						<div
							class="pointer-events-none absolute inset-y-0 left-0 bg-sky-deep/70 backdrop-grayscale"
							style={{ width: `${selLeft}%` }}
						/>
						<div
							class="pointer-events-none absolute inset-y-0 right-0 bg-sky-deep/70 backdrop-grayscale"
							style={{ width: `${100 - selRight}%` }}
						/>

						{/* feasibility horizon: the region that won't fit the size cap */}
						{showHorizon ? (
							<>
								<div
									class="pointer-events-none absolute inset-y-0 right-0 bg-coral/25"
									style={{ left: `${horizonPct}%` }}
								/>
								<div
									class="pointer-events-none absolute inset-y-0 w-0.5 bg-coral/80"
									style={{ left: `${horizonPct}%` }}
								/>
							</>
						) : null}
					</div>

					{/* draggable selection body */}
					<div
						class="absolute inset-y-0 cursor-grab touch-none"
						style={{ left: `${selLeft}%`, width: `${selRight - selLeft}%` }}
						onPointerDown={beginFlat("move")}
					/>

					{/* yellow selection box */}
					<div
						class="pointer-events-none absolute inset-y-0 rounded-lg border-[3px] border-sun"
						style={{ left: `${selLeft}%`, width: `${selRight - selLeft}%` }}
					/>

					{/* red playhead */}
					<div
						class={`pointer-events-none absolute inset-y-0 w-0.5 bg-coral shadow-[0_0_6px_#e83b3a] transition-opacity ${playing.value ? "opacity-100" : "opacity-60"}`}
						style={{ left: `${vpn(playhead.value)}%` }}
					/>

					{/* Move grip: centered on the selection and straddling the yellow
					    border, so the whole selection can be dragged as one even when it's
					    too short to grab by its body. */}
					<div
						aria-label="Move selection"
						class="absolute top-0.5 z-20 flex h-5 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-md bg-sun"
						style={{ left: `${(selLeft + selRight) / 2}%` }}
						onPointerDown={beginFlat("move")}
					>
						<GripHorizontal class="size-3.5 text-sky-deep/70" />
					</div>

					<TrimHandle
						position={`${selLeft}%`}
						active={active === "start"}
						onDown={beginEdge("start")}
						label="Trim start"
					/>
					<TrimHandle
						position={`${selRight}%`}
						active={active === "end"}
						onDown={beginEdge("end")}
						label="Trim end"
					/>
				</div>
			</div>

			{/* In / out / duration readout */}
			<div class="mt-2.5 flex items-center justify-between text-sm tabular-nums">
				<span
					class={`flex flex-col ${active === "start" ? "text-sun" : "text-star-soft"}`}
				>
					<span class="text-[0.6rem] font-bold tracking-wide uppercase">
						In
					</span>
					<span class="font-bold">{timecode(start, settings.value.fps)}</span>
				</span>
				<span class="rounded-full bg-sun/15 px-3 py-1 text-sm font-bold text-sun">
					{(end - start).toFixed(2)}s
				</span>
				<span
					class={`flex flex-col items-end ${active === "end" ? "text-sun" : "text-star-soft"}`}
				>
					<span class="text-[0.6rem] font-bold tracking-wide uppercase">
						Out
					</span>
					<span class="font-bold">{timecode(end, settings.value.fps)}</span>
				</span>
			</div>
		</Panel>
	);
}

function TrimHandle(props: {
	position: string;
	active: boolean;
	onDown: (event: PointerEvent) => void;
	label: string;
}) {
	return (
		<div
			role="slider"
			aria-label={props.label}
			tabIndex={0}
			class="absolute inset-y-0 z-10 flex w-9 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center"
			style={{ left: props.position }}
			onPointerDown={props.onDown}
			onKeyDown={(event) => {
				const edge = props.label === "Trim start" ? "start" : "end";
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					nudge(edge, -1);
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					nudge(edge, 1);
				}
			}}
		>
			<span
				class={`flex items-center justify-center gap-[3px] rounded-md bg-sun transition-all ${props.active ? "h-16 w-5" : "h-14 w-4"}`}
			>
				<span class="h-5 w-px rounded bg-sky-deep/70" />
				<span class="h-5 w-px rounded bg-sky-deep/70" />
			</span>
		</div>
	);
}

// Flat (no pop) round control for the timeline zoom in/out pair — deliberately
// lower-key than the elevated IconButton primitive used for primary actions.
function ZoomButton(props: {
	label: string;
	disabled: boolean;
	onClick: () => void;
	children: ComponentChildren;
}) {
	return (
		<button
			type="button"
			aria-label={props.label}
			disabled={props.disabled}
			onClick={props.onClick}
			class="flex size-7 items-center justify-center rounded-full border-2 border-sky-line bg-sky-deep/50 text-star transition hover:border-star/40 disabled:pointer-events-none disabled:opacity-30"
		>
			{props.children}
		</button>
	);
}

function SettingsCard() {
	const s = settings.value;
	const target = targetMode.value;

	return (
		<Panel class="p-4">
			<div class="grid gap-4">
				<ModeToggle target={target} />

				<ChipRow
					icon={<Film class="size-4 text-sun" />}
					label="Frame rate"
					options={[10, 15, 24].map((value) => ({ value, label: `${value}` }))}
					active={s.fps}
					onPick={(fps) => updateSettings({ fps })}
				/>

				{target ? (
					<TargetSizeRow />
				) : (
					<ChipRow
						icon={<Sparkles class="size-4 text-sun" />}
						label="Quality"
						options={[
							{ value: 70, label: "Good" },
							{ value: 85, label: "High" },
							{ value: 95, label: "Max" },
						]}
						active={s.quality}
						onPick={(quality) => updateSettings({ quality })}
					/>
				)}

				<ChipRow
					icon={<Maximize2 class="size-4 text-sun" />}
					label={target ? "Max res" : "Max size"}
					options={[
						{ value: 360, label: "360" },
						{ value: 480, label: "480" },
						{ value: 720, label: "720" },
					]}
					active={s.maxSize}
					onPick={(maxSize) => updateSettings({ maxSize })}
				/>

				<ChipRow
					icon={<Repeat class="size-4 text-sun" />}
					label="Loop"
					options={[
						{ value: 0, label: "∞" },
						{ value: 1, label: "1×" },
						{ value: 2, label: "2×" },
						{ value: 3, label: "3×" },
					]}
					active={s.repeat}
					onPick={(repeat) => updateSettings({ repeat })}
				/>
			</div>

			{target ? (
				<p class="mt-3 px-1 text-[0.7rem] leading-snug text-star-soft">
					Finds the highest quality under your cap. If even the lowest quality
					won&apos;t fit, it steps the resolution down from{" "}
					<span class="font-bold text-star">Max res</span>.
				</p>
			) : null}
		</Panel>
	);
}

function ModeToggle(props: { target: boolean }) {
	return (
		<div class="flex gap-1.5 rounded-full border-2 border-sky-line bg-sky-deep/50 p-1">
			<SegButton active={!props.target} onClick={() => setTargetMode(false)}>
				<Sparkles class="size-4" />
				Quality
			</SegButton>
			<SegButton active={props.target} onClick={() => setTargetMode(true)}>
				<Gauge class="size-4" />
				Target size
			</SegButton>
		</div>
	);
}

function TargetSizeRow() {
	const mb = targetBytes.value / MB;
	const label = mb >= 10 ? mb.toFixed(0) : mb.toFixed(mb % 1 === 0 ? 0 : 1);

	return (
		<div class="grid gap-2">
			<Label>
				<Target class="size-4 text-sun" />
				Target size
			</Label>
			<div class="flex items-center gap-1.5">
				{TARGET_PRESETS.map((preset) => (
					<Chip
						key={preset}
						active={Math.abs(mb - preset) < 0.05}
						onClick={() => setTargetBytes(preset * MB)}
					>
						{preset} MB
					</Chip>
				))}
				<div class="ml-auto flex items-center gap-1.5">
					<input
						type="number"
						inputMode="decimal"
						min="0.1"
						step="0.5"
						value={label}
						onInput={(event) => {
							const next = Number.parseFloat(event.currentTarget.value);
							if (Number.isFinite(next) && next > 0) setTargetBytes(next * MB);
						}}
						class="w-20 rounded-full border-2 border-sky-line bg-sky-deep/50 px-3 py-2 text-right text-sm font-bold text-star tabular-nums outline-none focus:border-sun"
						aria-label="Maximum file size in megabytes"
					/>
					<span class="text-sm font-bold text-star-soft">MB</span>
				</div>
			</div>
		</div>
	);
}

function ChipRow(props: {
	icon: ComponentChildren;
	label: string;
	options: { value: number; label: string }[];
	active: number;
	onPick: (value: number) => void;
}) {
	return (
		<div class="flex items-center justify-between gap-3">
			<Label>
				{props.icon}
				{props.label}
			</Label>
			<div class="flex gap-1.5">
				{props.options.map((option) => (
					<Chip
						key={option.value}
						active={props.active === option.value}
						onClick={() => props.onPick(option.value)}
					>
						{option.label}
					</Chip>
				))}
			</div>
		</div>
	);
}

function ResultCard() {
	const item = prepared.value;
	const outcome = targetOutcome.value;

	return (
		<Panel tone="result" class="p-4 text-center">
			<p class="display text-lg text-lilac">GIF ready</p>
			<p class="mt-1 text-sm text-star-soft">
				{item
					? `${item.width}×${item.height} · ${item.frames.length} frames`
					: ""}{" "}
				· {formatBytes(outputSize.value)}
			</p>
			{outcome ? (
				<p
					class={`mt-2 text-xs font-semibold ${outcome.fits ? "text-star-soft" : "text-coral"}`}
				>
					{outcome.fits
						? `Best quality under ${formatBytes(outcome.cap)}`
						: `Smallest possible — couldn't get under ${formatBytes(outcome.cap)}`}
				</p>
			) : null}
		</Panel>
	);
}

function ActionBar() {
	const showError = stage.value === "error";
	const status = showError ? errorText.value : statusText.value;

	return (
		<div class="sticky bottom-0 z-20 -mx-4 mt-4 px-4 pt-3 pb-1">
			<Panel as="div" tone="bar" class="p-3">
				<ProgressBar />
				<EstimateRow />
				<TargetFitRow />
				<FeasibilityRow />
				{status ? (
					<p
						class={`mb-2 px-1 text-center text-xs font-semibold ${showError ? "text-coral" : "text-star-soft"}`}
					>
						{status}
					</p>
				) : null}

				{stage.value === "done" && outputUrl.value ? (
					<div class="flex items-center gap-2">
						<IconButton
							shape="control"
							title="Start over"
							aria-label="Start over"
							onClick={resetAll}
						>
							<RotateCcw class="size-5" />
						</IconButton>
						<IconButton
							shape="control"
							title="Adjust settings"
							aria-label="Adjust settings"
							onClick={editAgain}
						>
							<SlidersHorizontal class="size-5" />
						</IconButton>
						<ButtonLink
							block
							tone="sun"
							shape="control"
							href={outputUrl.value}
							download={outputFilename()}
							onClick={offerInstall}
						>
							<Download class="size-5" />
							Save {formatBytes(outputSize.value)}
						</ButtonLink>
					</div>
				) : !hasMedia.value ? (
					<Button block tone="sun" shape="control" onClick={openFilePicker}>
						<FolderOpen class="size-5" />
						Open Video
					</Button>
				) : (
					<div class="flex items-center gap-2">
						<IconButton
							shape="control"
							title="Start over"
							aria-label="Start over"
							disabled={isBusy.value}
							onClick={resetAll}
						>
							<RotateCcw class="size-5" />
						</IconButton>
						<Button
							block
							tone="sun"
							shape="control"
							disabled={
								!canEncode.value || (!!video.value && !selectionFits.value)
							}
							onClick={() => void runEncode()}
						>
							{isBusy.value ? (
								<Loader2 class="size-5 animate-spin" />
							) : (
								<Play class="size-5" fill="currentColor" />
							)}
							{isBusy.value
								? "Working…"
								: targetMode.value
									? `Fit ${formatBytes(targetBytes.value)}`
									: "Export GIF"}
						</Button>
					</div>
				)}
			</Panel>
		</div>
	);
}

function EstimateRow() {
	// Quality mode only, and only when the selection is encodable. Hidden in target
	// mode (the search drives size), when too long (FeasibilityRow takes over), once
	// there's a real file size to show, and while a real encode runs.
	if (
		targetMode.value ||
		!hasMedia.value ||
		!selectionFits.value ||
		isBusy.value ||
		stage.value === "done"
	) {
		return null;
	}

	const bytes = estimatedBytes.value;
	const busy = estimating.value;
	// Nothing to show yet and not working on it (e.g. a probe failed) — stay quiet.
	if (bytes == null && !busy) return null;

	return (
		<p class="mb-2 flex items-center justify-center gap-1.5 px-1 text-center text-xs font-semibold text-star-soft">
			<Gauge class="size-3.5 text-sun" />
			{bytes == null ? (
				<span>Estimating size…</span>
			) : (
				<>
					<span>Estimated size</span>
					<span class="font-bold text-star tabular-nums">
						~{formatBytes(bytes)}
					</span>
					{busy ? <Loader2 class="size-3 animate-spin text-star-soft" /> : null}
				</>
			)}
		</p>
	);
}

// Positive confirmation in target mode that the selection fits, with headroom.
function TargetFitRow() {
	if (
		!targetMode.value ||
		!video.value ||
		!selectionFits.value ||
		isBusy.value ||
		stage.value === "done"
	) {
		return null;
	}
	const limit = fitLimitSeconds.value;
	if (!Number.isFinite(limit)) return null; // floor not measured yet
	return (
		<p class="mb-2 flex items-center justify-center gap-1.5 px-1 text-center text-xs font-semibold text-star-soft">
			<Gauge class="size-3.5 text-sun" />
			Fits {formatBytes(targetBytes.value)} — room for ~{limit.toFixed(1)}s
		</p>
	);
}

// Shown in either mode when the selection is too long for the cap or the frame
// budget. Explains which limit binds and offers one-tap remedies.
function FeasibilityRow() {
	if (
		!video.value ||
		selectionFits.value ||
		isBusy.value ||
		stage.value === "done"
	)
		return null;
	const limit = fitLimitSeconds.value;
	if (!Number.isFinite(limit)) return null;

	const suggestFps = fpsFit.value;
	const message =
		fitConstraint.value === "size"
			? `Too long for ${formatBytes(targetBytes.value)} — fits about ~${limit.toFixed(1)}s`
			: `Too long at ${settings.value.fps} fps — smooth up to ~${limit.toFixed(1)}s`;

	return (
		<div class="mb-2 grid gap-2 px-1">
			<p class="flex items-center justify-center gap-1.5 text-center text-xs font-semibold text-coral">
				<AlertTriangle class="size-3.5" />
				{message}
			</p>
			<div class="flex items-center justify-center gap-2">
				<button
					type="button"
					onClick={trimToFit}
					class="pop inline-flex min-h-9 items-center gap-1.5 rounded-full bg-sun px-3.5 text-xs font-extrabold tracking-wide text-sky-deep uppercase transition hover:bg-sun-glow"
				>
					<Scissors class="size-3.5" />
					Trim to ~{limit.toFixed(1)}s
				</button>
				{suggestFps ? (
					<button
						type="button"
						onClick={() => updateSettings({ fps: suggestFps })}
						class="inline-flex min-h-9 items-center gap-1.5 rounded-full border-2 border-sky-line bg-sky-deep/50 px-3.5 text-xs font-bold tracking-wide text-star uppercase transition hover:border-star/40"
					>
						<Film class="size-3.5 text-sun" />
						Use {suggestFps} fps
					</button>
				) : null}
			</div>
		</div>
	);
}

function ProgressBar() {
	const visible = isBusy.value;
	const width =
		stage.value === "encoding" ? 80 : Math.round(progress.value * 100);

	if (!visible) return null;

	return (
		<div class="mb-2 h-1.5 overflow-hidden rounded-full bg-sky-deep">
			<div
				class="h-full rounded-full bg-sun transition-all"
				style={{ width: `${Math.max(6, width)}%` }}
			/>
		</div>
	);
}

// PreviewStage's effect reacts to this signal and drives the element.
function togglePlay() {
	playing.value = !playing.value;
}

/* ---------------- trim timeline: QuickTime-style magnify-on-grab ---------------- */

function durationOf() {
	return video.peek()?.duration ?? 0;
}

/** Shortest allowed clip, in seconds (two frames). */
function minClipLen() {
	return Math.max(2 / settings.value.fps, 0.05);
}

/** Nudge a trim edge by N frames (keyboard arrows on a focused handle). */
function nudge(edge: "start" | "end", frames: number) {
	const step = frames / settings.value.fps;
	const t = trim.peek();
	const min = minClipLen();
	const next: Trim =
		edge === "start"
			? { ...t, start: clamp(t.start + step, 0, t.end - min) }
			: { ...t, end: clamp(t.end + step, t.start + min, durationOf()) };
	trim.value = next;
	const focus = edge === "start" ? next.start : next.end;
	if (previewEl) previewEl.currentTime = focus;
	playhead.value = focus;
}

/* ---------------- filmstrip: cached overview + on-grab fine detail ---------------- */

let overviewUrls: string[] = [];
let fineToken: CancelToken = { cancelled: false };
let fineGeneration = 0;
let fineTimer: ReturnType<typeof setTimeout> | undefined;

/** Extract the whole-clip overview once; this is what shows when nothing is grabbed. */
async function loadOverview() {
	const source = video.peek();
	if (!source) return;
	const urls = await extractFilmstrip(source.file, OVERVIEW_COUNT, {
		from: 0,
		to: source.duration,
	});
	overviewUrls = urls;
	filmstrip.value = urls;
	stripRange.value = { start: 0, end: source.duration };
}

/** Extract crisp thumbnails for the magnified window, swapping them in when ready. */
async function loadFine(start: number, end: number) {
	const source = video.peek();
	if (!source) return;
	fineToken.cancelled = true;
	const token: CancelToken = { cancelled: false };
	fineToken = token;
	const generation = ++fineGeneration;

	try {
		const urls = await extractFilmstrip(source.file, FINE_COUNT, {
			from: start,
			to: end,
			signal: token,
		});
		if (generation !== fineGeneration || urls.length === 0) {
			releaseFilmstrip(urls);
			return;
		}
		const previous = filmstrip.value;
		filmstrip.value = urls;
		stripRange.value = { start, end };
		if (previous !== overviewUrls) releaseFilmstrip(previous);
	} catch {
		// aborted or failed; keep whatever is shown
	}
}

function scheduleFine(start: number, end: number) {
	clearTimeout(fineTimer);
	fineTimer = setTimeout(() => void loadFine(start, end), 140);
}

/** Drop back to the whole-clip overview (cached thumbnails, full view). */
function restoreOverview() {
	fineToken.cancelled = true;
	clearTimeout(fineTimer);
	const current = filmstrip.value;
	if (current !== overviewUrls) releaseFilmstrip(current);
	filmstrip.value = overviewUrls;
	stripRange.value = { start: 0, end: durationOf() };
	view.value = { start: 0, end: durationOf() };
}

/** Apply a persistent zoom window, loading the right thumbnails for it. */
function applyView(start: number, end: number) {
	if (end - start >= durationOf() - 1e-3) {
		restoreOverview();
		return;
	}
	view.value = { start, end };
	scheduleFine(start, end);
}

/** Zoom the timeline by a factor (>1 zooms in), keeping the selection centered. */
function zoomView(factor: number) {
	const d = durationOf();
	if (!d) return;
	const cur = view.peek();
	const curLen = cur.end - cur.start;
	const t = trim.peek();
	const selCenter = (t.start + t.end) / 2;
	// Anchor on the selection when it's visible, otherwise on the current center.
	const center =
		selCenter >= cur.start && selCenter <= cur.end
			? selCenter
			: (cur.start + cur.end) / 2;
	const minLen = Math.min(d, MIN_VIEW_SECONDS);
	const newLen = clamp(curLen / factor, minLen, d);
	const s = clamp(center - newLen / 2, 0, d - newLen);
	applyView(s, s + newLen);
}

const FILE_ACCEPT = "image/*,video/mp4,video/webm,video/quicktime,video/*";

/** Open the native file chooser without a visible input (used by the action bar). */
function openFilePicker() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = FILE_ACCEPT;
	input.multiple = true;
	input.addEventListener("change", () => void selectFiles(input.files));
	input.click();
}

async function selectFiles(selected: FileList | null) {
	if (!selected?.length) return;

	resetMedia();
	clearOutput();
	errorText.value = "";

	const list = [...selected];
	const selection = classifyFiles(list);

	if (selection.kind === "video") {
		try {
			stage.value = "loading";
			statusText.value = "Reading video…";
			const info = await loadVideoInfo(selection.files[0]);
			video.value = info;
			trim.value = { start: 0, end: info.duration };
			view.value = { start: 0, end: info.duration };
			playhead.value = 0;
			await loadOverview();
			stage.value = "idle";
			statusText.value = "";
			playing.value = !prefersReducedMotion();
			scheduleProbe();
			scheduleFloorProbe();
		} catch (error) {
			stage.value = "error";
			errorText.value =
				error instanceof Error
					? error.message
					: "The video could not be opened.";
		}
		return;
	}

	if (selection.files.length === 0) {
		stage.value = "error";
		errorText.value = "Choose a video or image frames first.";
		return;
	}

	imageFiles.value = selection.files;
	stage.value = "idle";
	statusText.value = `${selection.files.length} frames ready.`;
	scheduleProbe();
}

async function runEncode() {
	if (!canEncode.value) return;
	if (video.value && !selectionFits.value) return; // too long for the cap/frame budget — guidance shown instead

	const source = video.value ? [video.value.file] : imageFiles.value;
	if (source.length === 0) return;

	const releaseWakeLock = keepAwake();
	try {
		previewEl?.pause();
		playing.value = false;
		clearOutput();
		releasePrepared();
		errorText.value = "";

		const gif = targetMode.value
			? await encodeToTarget(targetBytes.value)
			: await encodeWith(settings.value);

		const blob = new Blob([gif], { type: "image/gif" });
		outputUrl.value = URL.createObjectURL(blob);
		outputSize.value = blob.size;
		stage.value = "done";
		statusText.value = "";
		offerInstall();
	} catch (error) {
		stage.value = "error";
		errorText.value =
			error instanceof Error ? error.message : "Encoding failed.";
	} finally {
		releaseWakeLock();
	}
}

/* ---------------- size estimate: probe-and-extrapolate (approach B) ---------------- */

let probeGeneration = 0;
let probeTimer: ReturnType<typeof setTimeout> | undefined;

async function runProbe() {
	const generation = ++probeGeneration;
	estimating.value = true;
	try {
		const res = await probeRateFor(settings.peek());
		if (generation !== probeGeneration) return;
		if (!res) {
			probeRate.value = null;
			probeKind.value = null;
			return;
		}
		probeKind.value = res.kind;
		probeRate.value = res.rate;
	} catch {
		// probe failed (decode/encode hiccup) — leave the last good estimate in place
	} finally {
		if (generation === probeGeneration) estimating.value = false;
	}
}

function scheduleProbe() {
	if (targetMode.peek()) return; // the live estimate is hidden in target mode
	clearTimeout(probeTimer);
	probeTimer = setTimeout(() => void runProbe(), PROBE_DEBOUNCE_MS);
}

let floorProbeGeneration = 0;
let floorProbeTimer: ReturnType<typeof setTimeout> | undefined;

/** Smallest resolution rung the search could ever drop to, given the current ceiling. */
function smallestRung(maxSize: number) {
	return Math.min(maxSize, MAXSIZE_LADDER[MAXSIZE_LADDER.length - 1]);
}

/** Measure the bytes/sec floor that powers the feasibility horizon (target mode, video). */
async function runFloorProbe() {
	const generation = ++floorProbeGeneration;
	const base = settings.peek();
	if (!targetMode.peek() || !video.peek()) {
		floorRate.value = null;
		return;
	}
	try {
		const res = await probeRateFor({
			...base,
			maxSize: smallestRung(base.maxSize),
			quality: QUALITY_FLOOR,
		});
		if (generation !== floorProbeGeneration) return;
		floorRate.value = res && res.kind === "video" ? res.rate : null;
	} catch {
		if (generation === floorProbeGeneration) floorRate.value = null;
	}
}

function scheduleFloorProbe() {
	if (!targetMode.peek() || !video.peek()) return;
	clearTimeout(floorProbeTimer);
	floorProbeTimer = setTimeout(() => void runFloorProbe(), PROBE_DEBOUNCE_MS);
}

function resetEstimate() {
	probeGeneration += 1;
	floorProbeGeneration += 1;
	clearTimeout(probeTimer);
	clearTimeout(floorProbeTimer);
	probeRate.value = null;
	probeKind.value = null;
	floorRate.value = null;
	estimating.value = false;
	targetOutcome.value = null;
}

// Settings that change the encoded bytes per unit and so invalidate the rate.
const SIZE_KEYS: (keyof EncodeSettings)[] = ["fps", "quality", "maxSize"];

function updateSettings(patch: Partial<EncodeSettings>) {
	settings.value = { ...settings.value, ...patch };
	if (SIZE_KEYS.some((key) => key in patch) && hasMedia.peek()) scheduleProbe();
	// fps changes the per-second floor, so the feasibility horizon must be re-measured.
	if ("fps" in patch) scheduleFloorProbe();
}

function setTargetMode(on: boolean) {
	if (targetMode.peek() === on) return;
	targetMode.value = on;
	targetOutcome.value = null;
	if (on) {
		resetEstimate(); // the live estimate gives way to the cap-driven search
		scheduleFloorProbe();
	} else if (hasMedia.peek()) {
		scheduleProbe();
	}
}

function setTargetBytes(bytes: number) {
	targetBytes.value = Math.max(64 * 1024, Math.round(bytes));
}

/** Shrink the selection to the longest length that fits the budget (keeps the In point). */
function trimToFit() {
	const limit = fitLimitSeconds.peek();
	if (!Number.isFinite(limit)) return;
	const t = trim.peek();
	const end = clamp(t.start + limit, t.start + minClipLen(), durationOf());
	trim.value = { ...t, end };
	scrubPreview(end);
}

function clearOutput() {
	if (outputUrl.value) URL.revokeObjectURL(outputUrl.value);
	outputUrl.value = null;
	outputSize.value = 0;
}

function resetMedia() {
	fineToken.cancelled = true;
	clearTimeout(fineTimer);
	resetEstimate();
	if (video.value) URL.revokeObjectURL(video.value.url);
	const shown = filmstrip.value;
	if (shown.length && shown !== overviewUrls) releaseFilmstrip(shown);
	if (overviewUrls.length) releaseFilmstrip(overviewUrls);
	overviewUrls = [];
	video.value = null;
	filmstrip.value = [];
	stripRange.value = { start: 0, end: 0 };
	view.value = { start: 0, end: 0 };
	activeEdge.value = null;
	imageFiles.value = [];
	playing.value = false;
	playhead.value = 0;
}

function resetAll() {
	clearOutput();
	releasePrepared();
	resetMedia();
	stage.value = "idle";
	progress.value = 0;
	statusText.value = "";
	errorText.value = "";
}

// Back to the settings/trim screen after an export, keeping the media so the
// user can tweak settings and encode again. Drops the finished GIF.
function editAgain() {
	clearOutput();
	stage.value = "idle";
	progress.value = 0;
	statusText.value = "";
	playing.value = !prefersReducedMotion();
}

// Name the download after the source file, swapping its extension for .gif.
function outputFilename() {
	const name = video.value?.file.name ?? imageFiles.value[0]?.name;
	const base = name?.replace(/\.[^./\\]+$/, "").trim();
	return `${base || "gifsky"}.gif`;
}

render(<App />, document.getElementById("app")!);
