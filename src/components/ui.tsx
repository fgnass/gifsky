import { classNames } from "classname-variants";
import { styled, tw } from "classname-variants/preact";
import { twMerge } from "tailwind-merge";

classNames.combine = twMerge;

// Shared look for the primary action button, reused by the <button> and the
// download <a> so the sun-control style lives in exactly one place.
const buttonVariants = {
	base: tw`pop inline-flex min-h-12 items-center justify-center gap-2 px-5 text-base font-extrabold tracking-wide uppercase transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sun disabled:pointer-events-none`,
	variants: {
		tone: {
			sun: tw`bg-sun text-sky-deep hover:bg-sun-glow`,
			lilac: tw`bg-lilac text-sky-deep hover:brightness-105`,
			ghost: tw`border-2 border-sky-line bg-sky-soft text-star hover:border-star/40`,
		},
		block: {
			true: tw`w-full`,
		},
		shape: {
			round: tw`rounded-full`,
			control: tw`rounded-control`,
		},
	},
	defaultVariants: {
		tone: "sun",
		shape: "round",
	},
} as const;

export const Button = styled("button", {
	...buttonVariants,
	defaultProps: {
		type: "button",
	},
});

// The download link in the action bar: same variants, rendered as an anchor.
export const ButtonLink = styled("a", buttonVariants);

export const IconButton = styled("button", {
	base: tw`pop inline-flex size-12 items-center justify-center border-2 border-sky-line bg-sky-soft text-star transition hover:border-star/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sun disabled:pointer-events-none`,
	variants: {
		shape: {
			round: tw`rounded-full`,
			control: tw`rounded-control`,
		},
	},
	defaultVariants: {
		shape: "round",
	},
	defaultProps: {
		type: "button",
	},
});

export const Panel = styled("section", {
	base: tw`rounded-panel border-2 border-sky-line`,
	variants: {
		tone: {
			soft: tw`bg-sky-soft/70`,
			stage: tw`overflow-hidden bg-sky-deep shadow-pop`,
			bar: tw`bg-sky-soft/90 shadow-lift backdrop-blur`,
			result: tw`border-lilac/40 bg-lilac/10`,
		},
	},
	defaultVariants: {
		tone: "soft",
	},
});

// Segmented-control button (the Quality / Target-size toggle). Same active/idle
// idiom as Chip, but stretches to fill its half of the track.
export const SegButton = styled("button", {
	base: tw`inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full text-sm font-bold tracking-wide uppercase transition`,
	variants: {
		active: {
			true: tw`bg-sun text-sky-deep`,
			false: tw`text-star-soft hover:text-star`,
		},
	},
	defaultVariants: {
		active: false,
	},
	defaultProps: {
		type: "button",
	},
});

// The uppercase field label sitting left of each settings row.
export const Label = styled("span", {
	base: tw`flex items-center gap-2 text-sm font-bold tracking-wide text-star uppercase`,
});

export const Pill = styled("span", {
	base: tw`inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 text-xs font-bold tracking-wide uppercase`,
	variants: {
		tone: {
			neutral: tw`border-sky-line bg-sky-deep/60 text-star-soft`,
			lilac: tw`border-lilac/40 bg-lilac/10 text-lilac`,
			warn: tw`border-coral/40 bg-coral/10 text-coral`,
		},
	},
	defaultVariants: {
		tone: "neutral",
	},
});

export const Chip = styled("button", {
	base: tw`inline-flex min-h-10 min-w-11 items-center justify-center rounded-full border-2 px-3.5 text-sm font-bold tracking-wide uppercase tabular-nums transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sun`,
	variants: {
		active: {
			true: tw`border-sun bg-sun text-sky-deep`,
			false: tw`border-sky-line bg-sky-deep/50 text-star-soft hover:border-star/30 hover:text-star`,
		},
	},
	defaultVariants: {
		active: false,
	},
	defaultProps: {
		type: "button",
	},
});
