import type { Dye } from "@aomc/shared/colors";

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

/* Block textures for the dimension buttons, generated from a seeded noise so they never change. */

type BlockKind = "grass" | "deepslate" | "netherrack" | "end_stone" | "stone";

const BLOCK_PALETTES: Record<BlockKind, [string, number][]> = {
	grass: [
		["#866043", 50],
		["#79553a", 25],
		["#966c4a", 15],
		["#593d29", 10],
	],
	deepslate: [
		["#4d4d50", 45],
		["#3d3d40", 30],
		["#5e5e62", 15],
		["#2c2c2f", 10],
	],
	netherrack: [
		["#723232", 45],
		["#612828", 25],
		["#854040", 15],
		["#4b1d1d", 10],
		["#a05252", 5],
	],
	end_stone: [
		["#dbde9e", 45],
		["#c9cc8c", 25],
		["#e8eab4", 15],
		["#b5b77a", 15],
	],
	stone: [
		["#7f7f7f", 45],
		["#737373", 25],
		["#8f8f8f", 20],
		["#686868", 10],
	],
};

const GRASS: [string, number][] = [
	["#6aaa40", 45],
	["#5b9435", 30],
	["#7fbf4f", 25],
];

function blockCells(kind: BlockKind) {
	let seed = kind.length * 7919 + kind.charCodeAt(0);
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const pick = (palette: [string, number][]) => {
		const total = palette.reduce((sum, [, w]) => sum + w, 0);
		let r = rand() * total;
		for (const [c, w] of palette) {
			r -= w;
			if (r < 0) return c;
		}
		return (palette[0] as [string, number])[0];
	};
	const out: ReturnType<typeof rects> = [];
	for (let y = 0; y < 16; y++) {
		for (let x = 0; x < 16; x++) {
			// Grass hangs over the dirt by a ragged 3 to 5 pixels.
			const grassDepth = 3 + ((x * 5 + 3) % 3);
			const palette =
				kind === "grass" && y < grassDepth ? GRASS : BLOCK_PALETTES[kind];
			out.push({ x, y, w: 1, fill: pick(palette) });
		}
	}
	return out;
}

/** Guesses a block for a dimension from its slug; anything unknown is stone. */
export function blockFor(slug: string): BlockKind {
	if (slug.includes("nether")) return "netherrack";
	if (slug.includes("end")) return "end_stone";
	if (slug.includes("cave")) return "deepslate";
	if (slug.includes("overworld")) return "grass";
	return "stone";
}

const blockCache = new Map<BlockKind, ReturnType<typeof rects>>();

export function BlockIcon(props: { slug: string; size?: number }) {
	const kind = blockFor(props.slug);
	let cells = blockCache.get(kind);
	if (!cells) {
		cells = blockCells(kind);
		blockCache.set(kind, cells);
	}
	return <Pixels cells={cells} size={props.size ?? 20} class="block-icon" />;
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
