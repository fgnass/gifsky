// Pure formatting + math helpers, free of any signal/DOM state so they can be
// unit-tested in isolation.

export function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

/** Frame-accurate timecode: m:ss.ff */
export function timecode(seconds: number, fps: number) {
	const totalFrames = Math.max(0, Math.round(seconds * fps));
	const f = totalFrames % fps;
	const totalSeconds = Math.floor(totalFrames / fps);
	const s = totalSeconds % 60;
	const m = Math.floor(totalSeconds / 60);
	return `${m}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

/** QuickTime-style mm:ss,ff timecode for the drag tooltip. */
export function timecodeFrames(seconds: number, fps: number) {
	const totalFrames = Math.max(0, Math.round(seconds * fps));
	const f = totalFrames % fps;
	const totalSeconds = Math.floor(totalFrames / fps);
	const s = totalSeconds % 60;
	const m = Math.floor(totalSeconds / 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(2, "0")}`;
}

// Decimal (SI) units to match how Finder/iOS report file sizes — a "5 MB" cap
// and the size shown here line up with what the user sees after saving.
export function formatBytes(bytes: number) {
	if (!bytes) return "0 B";

	const units = ["B", "KB", "MB", "GB"];
	let size = bytes;
	let unit = 0;

	while (size >= 1000 && unit < units.length - 1) {
		size /= 1000;
		unit += 1;
	}

	return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
