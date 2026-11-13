export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
	const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (rgb: Rgb): string =>
	`#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

const toLinear = (v: number) => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) =>
	255 *
	Math.min(
		1,
		Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055),
	);

function toOklab([r, g, b]: Rgb): Rgb {
	const lr = toLinear(r);
	const lg = toLinear(g);
	const lb = toLinear(b);
	const l = Math.cbrt(
		0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
	);
	const m = Math.cbrt(
		0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
	);
	const s = Math.cbrt(
		0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
	);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: Rgb): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

/** The mean of the colours, weighted by `count`, taken in Oklab so mixes stay bright. */
export function mixColors(parts: { data: Rgb; count: number }[]): Rgb {
	let total = 0;
	const sum: Rgb = [0, 0, 0];
	for (const { data, count } of parts) {
		const lab = toOklab(data);
		for (let i = 0; i < 3; i++)
			sum[i] = (sum[i] as number) + (lab[i] as number) * count;
		total += count;
	}
	return fromOklab(sum.map((v) => v / total) as Rgb);
}

/** Text that reads on a fill of this colour: dark on light fills, white otherwise. */
export function textOn(rgb: Rgb): string {
	const [r, g, b] = rgb.map(toLinear) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#1d1d21" : "#fff";
}
