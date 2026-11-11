import type { Dye } from "@aomc/shared/colors";
import type { DimensionTheme } from "@aomc/shared/schemas";

/** 16×16 pixel art: one string per row, one character per pixel, "." is transparent. */
type Art = string[];

const PALETTE: Record<string, string> = {
	k: "#1d1d1d",
	w: "#ffffff",
	Y: "#e8b923",
	y: "#fff38a",
	b: "#5b8bd8",
	g: "#5f9e3a",
	I: "#c9c9c9",
	d: "#3c3c3c",
	r: "#d8392b",
	R: "#8f2219",
	n: "#8a6331",
	N: "#5a3f1d",
	P: "#8c7a52",
	p: "#e9dcb0",
	a: "#4cd05a",
	O: "#7a3f12",
	o: "#c4692a",
	t: "#105247",
	T: "#2a8f7e",
	e: "#7fe0c8",
};

/** A round item (clock, compass): outline and rim around a 10×10 face, cropped to a circle. */
function disc(rim: string, face: string[]): Art {
	const R = rim;
	const row = (i: number, from: number, to: number) =>
		(face[i] as string).slice(from, to);
	return [
		"................",
		".....kkkkkk.....",
		`...kk${R.repeat(6)}kk...`,
		`..k${R}${R}${row(0, 2, 8)}${R}${R}k..`,
		`..k${R}${row(1, 1, 9)}${R}k..`,
		...face.slice(2, 8).map((r) => `.k${R}${r}${R}k.`),
		`..k${R}${row(8, 1, 9)}${R}k..`,
		`..k${R}${R}${row(9, 2, 8)}${R}${R}k..`,
		`...kk${R.repeat(6)}kk...`,
		".....kkkkkk.....",
		"................",
	];
}

const ICONS = {
	clock: [
		disc("Y", [
			"bbbbbbbbbb",
			"bbbbbwbbbb",
			"byybbwbbbb",
			"byybbwbbbb",
			"bbbbbwbbbb",
			"gggggwwwgg",
			"gggggggggg",
			"gggggggggg",
			"gggggggggg",
			"gggggggggg",
		]),
	],
	compass: [
		disc("I", [
			"dddddddddd",
			"dddddddrrd",
			"ddddddrrrd",
			"dddddrrrdd",
			"ddddrrrddd",
			"dddwwwdddd",
			"ddwwwddddd",
			"dwwwdddddd",
			"dwwddddddd",
			"dddddddddd",
		]),
	],
	banner: [
		[
			"................",
			"...nnnnnnnnnn...",
			"...nNNNNNNNNn...",
			"....rrrrrrrr....",
			"....rrrrrrrr....",
			"....rwwwwwwr....",
			"....rrrrrrrr....",
			"....rrrwwrrr....",
			"....rrwwwwrr....",
			"....rrrwwrrr....",
			"....rrrrrrrr....",
			"....RrrrrrrR....",
			"....RRrrrrRR....",
			".......nn.......",
			".......nn.......",
			".......nn.......",
		],
	],
	upload: [
		[
			"................",
			"PPPPPPPPPPPP....",
			"PppppppppppP....",
			"PpggbbbgggpP....",
			"PpgbbbggggpP....",
			"PpgbbggggypP....",
			"PpggggggbbpP....",
			"PpgrgggbbbpP....",
			"PpggggggbbpP....",
			"PpgggggggbpP....",
			"PpggyggggbpP....",
			"PppppppppppP....",
			"PPPPPPPPPPPP....",
			"................",
			"................",
			"................",
		],
		[
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			"............k...",
			"...........kak..",
			"..........kaaak.",
			".........kaaaaak",
			".........kkaaakk",
			"..........kaaak.",
			"..........kaaak.",
			"..........kkkkk.",
			"................",
		],
	],
	pearl: [
		[
			"................",
			"................",
			"......kkkk......",
			"....kkTTTTkk....",
			"...kTTeeTTTTk...",
			"...kTewweTTTk...",
			"..kTTewweTTTtk..",
			"..kTTTeeTTTTtk..",
			"..kTTTTTTTTttk..",
			"..kTTTTTTTTttk..",
			"...kTTTTTTttk...",
			"...ktTTTTtttk...",
			"....kkttttkk....",
			"......kkkk......",
			"................",
			"................",
		],
	],
	command: [
		[
			"OOOOOOOOOOOOOOOO",
			"OooooooooooooooO",
			"OoOOOOOOOOOOOOoO",
			"OoOddddddddddOoO",
			"OoOdwddddddddOoO",
			"OoOddwdddddddOoO",
			"OoOdddwddddddOoO",
			"OoOddwdddddddOoO",
			"OoOdwddddddddOoO",
			"OoOddddddddddOoO",
			"OoOddddwwwwddOoO",
			"OoOddddddddddOoO",
			"OoOddddddddddOoO",
			"OoOOOOOOOOOOOOoO",
			"OooooooooooooooO",
			"OOOOOOOOOOOOOOOO",
		],
	],
} satisfies Record<string, Art[]>;

export type IconName = keyof typeof ICONS;

/** Horizontal runs of one colour become one rect each, which keeps the SVGs small. */
function rects(layers: Art[], palette: Record<string, string>) {
	const grid: (string | null)[][] = Array.from({ length: 16 }, () =>
		Array(16).fill(null),
	);
	for (const art of layers)
		art.forEach((row, y) => {
			for (let x = 0; x < 16; x++) {
				const c = row[x];
				if (c && c !== ".") (grid[y] as (string | null)[])[x] = palette[c] ?? c;
			}
		});
	const out: { x: number; y: number; w: number; fill: string }[] = [];
	grid.forEach((row, y) => {
		let x = 0;
		while (x < 16) {
			const fill = row[x];
			let end = x + 1;
			while (end < 16 && row[end] === fill) end++;
			if (fill) out.push({ x, y, w: end - x, fill });
			x = end;
		}
	});
	return out;
}

function Pixels(props: {
	cells: ReturnType<typeof rects>;
	size?: number;
	class?: string;
}) {
	const size = props.size ?? 32;
	return (
		<svg
			class={`pixel-icon ${props.class ?? ""}`}
			viewBox="0 0 16 16"
			width={size}
			height={size}
			shape-rendering="crispEdges"
			aria-hidden="true"
		>
			{props.cells.map((r) => (
				<rect
					key={`${r.x},${r.y}`}
					x={r.x}
					y={r.y}
					width={r.w}
					height={1}
					fill={r.fill}
				/>
			))}
		</svg>
	);
}

const iconCache = new Map<string, ReturnType<typeof rects>>();

export function PixelIcon(props: {
	name: IconName;
	size?: number;
	class?: string;
}) {
	let cells = iconCache.get(props.name);
	if (!cells) {
		cells = rects(ICONS[props.name], PALETTE);
		iconCache.set(props.name, cells);
	}
	return <Pixels cells={cells} size={props.size} class={props.class} />;
}

const BLOCKS: Record<DimensionTheme, string> = {
	overworld: "grass",
	nether: "netherrack",
	end: "endstone",
};

/** The block standing for a dimension, from its theme. */
export function BlockIcon(props: { theme: DimensionTheme; size?: number }) {
	const size = props.size ?? 20;
	return (
		<img
			class="block-icon"
			src={`/static/blocks/${BLOCKS[props.theme]}.png`}
			alt=""
			width={size}
			height={size}
		/>
	);
}

/** The banner marker of a dye colour, as drawn on the map. */
export function Banner(props: { dye: Dye; size?: number }) {
	const size = props.size ?? 16;
	return (
		<img
			class="banner"
			src={`/static/markers/${props.dye}_banner.png`}
			alt=""
			width={size}
			height={size}
		/>
	);
}
