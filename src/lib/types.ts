export type FrameSourceKind = "images" | "video";

export type FramePreview = {
	url: string;
	width: number;
	height: number;
};

export type PreparedFrames = {
	kind: FrameSourceKind;
	frames: ImageData[];
	previews: FramePreview[];
	width: number;
	height: number;
	sourceLabel: string;
};

export type EncodeSettings = {
	fps: number;
	quality: number;
	maxSize: number;
	repeat: number;
};

/** A trim window over a video source, in seconds. */
export type Trim = {
	start: number;
	end: number;
};

export type VideoInfo = {
	file: File;
	url: string;
	duration: number;
	width: number;
	height: number;
};

export type EncoderRequest = {
	type: "encode";
	frames: ImageData[];
	width: number;
	height: number;
	fps: number;
	quality: number;
	repeat: number;
};

export type EncoderResponse =
	| { type: "ready" }
	| { type: "result"; gif: ArrayBuffer }
	| { type: "error"; message: string };
