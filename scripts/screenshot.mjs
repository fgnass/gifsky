/**
 * Portfolio screenshot generator.
 *
 * Spins up the Vite dev server and captures the app at an iPhone-class viewport
 * scaled 2× → exactly 780 × 1688. Produces two shots:
 *
 *   public/screenshots/start.png    the drop-zone landing (default empty state)
 *   public/screenshots/editor.png   the editor: a clip loaded on the trim timeline
 *                            with the settings card, ready to export
 *
 * The editor shot feeds the bundled demo.mp4 through the real file picker (via
 * Playwright's setInputFiles), so the preview, filmstrip thumbnails, and trim
 * bar all render from genuine decoded frames — no app-side demo hook needed.
 *
 * Because the sample is H.264, we drive Google Chrome (channel: "chrome")
 * rather than Playwright's bundled Chromium, which omits proprietary codecs.
 *
 * Re-run any time the UI changes:  npm run screenshot
 * Override the previewed frame time:  npm run screenshot -- --seek=4
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "public/screenshots");
const sample = resolve(root, "demo.mp4");

// Target output is 780 × 1688. We render at half that on a high-DPI viewport so
// the UI renders crisply, then capture at the native device pixels.
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2; // 390×844 @2x = 780×1688

const PORT = 5181;
const BASE = `http://127.0.0.1:${PORT}/`;

// Cap any wait so a regression can't hang the run.
const WAIT_TIMEOUT_MS = 30_000;

function parseArgs() {
	const out = {};
	for (const arg of process.argv.slice(2)) {
		const match = /^--([^=]+)=(.*)$/.exec(arg);
		if (match) out[match[1]] = match[2];
	}
	return out;
}

// Frame (seconds into the clip) shown behind the play button in the editor shot.
const SEEK_TIME = Number(parseArgs().seek ?? 2.5);

function startServer() {
	const child = spawn(
		"npx",
		["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
	);
	return new Promise((res, rej) => {
		const timer = setTimeout(
			() => rej(new Error("Vite did not start in time")),
			30_000,
		);
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk);
			if (/Local:.*http/.test(String(chunk))) {
				clearTimeout(timer);
				res(child);
			}
		});
		child.on("exit", (code) => rej(new Error(`Vite exited early (code ${code})`)));
	});
}

/** The drop-zone landing — just wait for the branded empty state to render. */
async function captureStart(context) {
	const page = await context.newPage();
	try {
		console.log(`Opening ${BASE}`);
		await page.goto(BASE, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForSelector("h1.display", { timeout: WAIT_TIMEOUT_MS });
		await save(page, "start");
	} finally {
		await page.close();
	}
}

/** The editor — load the sample clip through the picker, seek to a nice frame. */
async function captureEditor(context) {
	const page = await context.newPage();
	try {
		console.log(`Opening ${BASE} (editor)`);
		await page.goto(BASE, { waitUntil: "networkidle" });
		await page.setInputFiles("input[type=file]", sample);

		// Ready once the preview has a decoded frame and the filmstrip is populated
		// (thumbnails are canvas → blob: URLs; the drop-zone icon is a static PNG).
		await page.waitForFunction(
			() => {
				const v = document.querySelector(".checkerboard video");
				const thumbs = document.querySelectorAll('img[src^="blob:"]');
				return !!v && v.readyState >= 2 && thumbs.length >= 3;
			},
			null,
			{ timeout: WAIT_TIMEOUT_MS },
		);

		// Park a good frame behind the play button. Playback stays paused because the
		// context requests reduced motion, so this frame is what gets captured.
		await page.evaluate(async (t) => {
			const v = document.querySelector(".checkerboard video");
			if (!v) return;
			await new Promise((res) => {
				const done = () => {
					v.removeEventListener("seeked", done);
					res();
				};
				v.addEventListener("seeked", done);
				v.currentTime = t;
			});
		}, SEEK_TIME);

		await page.evaluate(() => document.fonts.ready);
		await save(page, "editor");
	} finally {
		await page.close();
	}
}

async function save(page, name) {
	const out = resolve(outDir, `${name}.png`);
	await page.screenshot({ path: out });
	console.log(`Saved ${out} (${VIEWPORT.width * SCALE} × ${VIEWPORT.height * SCALE})`);
}

async function main() {
	await mkdir(outDir, { recursive: true });

	console.log("Starting Vite…");
	const server = await startServer();

	const browser = await chromium.launch({ channel: "chrome" });
	try {
		const context = await browser.newContext({
			viewport: VIEWPORT,
			deviceScaleFactor: SCALE,
			isMobile: true,
			hasTouch: true,
			colorScheme: "dark",
			reducedMotion: "reduce",
		});
		await captureStart(context);
		await captureEditor(context);
	} finally {
		await browser.close();
		server.kill("SIGTERM");
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
