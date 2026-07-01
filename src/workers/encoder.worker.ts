import encode from "gifski-wasm";
import type { EncoderRequest, EncoderResponse } from "../lib/types";

declare const self: DedicatedWorkerGlobalScope;

self.postMessage({ type: "ready" } satisfies EncoderResponse);

self.onmessage = async (event: MessageEvent<EncoderRequest>) => {
	if (event.data.type !== "encode") {
		return;
	}

	try {
		const gif = await encode({
			frames: event.data.frames,
			width: event.data.width,
			height: event.data.height,
			fps: event.data.fps,
			quality: event.data.quality,
			repeat: event.data.repeat,
		});

		const buffer = gif.slice().buffer as ArrayBuffer;
		self.postMessage(
			{ type: "result", gif: buffer } satisfies EncoderResponse,
			[buffer],
		);
	} catch (error) {
		self.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : "GIF encoding failed.",
		} satisfies EncoderResponse);
	}
};
