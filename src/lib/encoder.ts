import type { EncoderRequest, EncoderResponse } from "./types";

export function encodeGif(
	request: Omit<EncoderRequest, "type">,
	onReady: () => void,
): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("../workers/encoder.worker.ts", import.meta.url),
			{
				type: "module",
			},
		);

		worker.onmessage = (event: MessageEvent<EncoderResponse>) => {
			const message = event.data;

			if (message.type === "ready") {
				onReady();
				worker.postMessage(
					{ type: "encode", ...request } satisfies EncoderRequest,
					transferFrameBuffers(request.frames),
				);
				return;
			}

			if (message.type === "result") {
				worker.terminate();
				resolve(message.gif);
				return;
			}

			if (message.type === "error") {
				worker.terminate();
				reject(new Error(message.message));
			}
		};

		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message || "The GIF encoder worker failed."));
		};
	});
}

function transferFrameBuffers(frames: ImageData[]): Transferable[] {
	return frames.map((frame) => frame.data.buffer);
}
