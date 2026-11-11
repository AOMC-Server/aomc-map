import sharp from "sharp";
import type { BlobStore } from "./blobstore";

/** All tile buffers are raw straight-alpha RGBA, tileSize * tileSize * 4 bytes. */

export function emptyTile(tileSize: number): Buffer {
	return Buffer.alloc(tileSize * tileSize * 4);
}

export function isEmpty(rgba: Uint8Array): boolean {
	for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
	return true;
}

/**
 * Composites src over dst ("over" operator) with src's top-left corner at (dx, dy) in dst
 * coordinates. Anything outside dst is clipped. Mutates dst.
 */
export function overRegion(
	dst: Uint8Array,
	dstW: number,
	src: Uint8Array,
	srcW: number,
	srcH: number,
	dx: number,
	dy: number,
): void {
	const dstH = dst.length / 4 / dstW;
	const x0 = Math.max(0, dx);
	const x1 = Math.min(dstW, dx + srcW);
	const y0 = Math.max(0, dy);
	const y1 = Math.min(dstH, dy + srcH);
	for (let y = y0; y < y1; y++) {
		let s = ((y - dy) * srcW + (x0 - dx)) * 4;
		let d = (y * dstW + x0) * 4;
		for (let x = x0; x < x1; x++, s += 4, d += 4) {
			const sa = src[s + 3] as number;
			if (sa === 0) continue;
			const da = dst[d + 3] as number;
			if (sa === 255 || da === 0) {
				dst[d] = src[s] as number;
				dst[d + 1] = src[s + 1] as number;
				dst[d + 2] = src[s + 2] as number;
				dst[d + 3] = sa;
				continue;
			}
			const dw = (da * (255 - sa)) / 255;
			const outA = sa + dw;
			for (let k = 0; k < 3; k++) {
				dst[d + k] = Math.round(
					((src[s + k] as number) * sa + (dst[d + k] as number) * dw) / outA,
				);
			}
			dst[d + 3] = Math.round(outA);
		}
	}
}

/**
 * Halves `child` (2x2 premultiplied average) into quadrant (i, j) of `parent`.
 * Quadrants are tile-local: i is the x half, j the z half.
 */
export function downscaleInto(
	parent: Uint8Array,
	child: Uint8Array,
	tileSize: number,
	i: number,
	j: number,
): void {
	const half = tileSize / 2;
	const stride = tileSize * 4;
	for (let py = 0; py < half; py++) {
		for (let px = 0; px < half; px++) {
			const s = 2 * py * stride + 2 * px * 4;
			const offsets = [s, s + 4, s + stride, s + stride + 4];
			let aSum = 0;
			let r = 0;
			let g = 0;
			let b = 0;
			for (const o of offsets) {
				const a = child[o + 3] as number;
				aSum += a;
				r += (child[o] as number) * a;
				g += (child[o + 1] as number) * a;
				b += (child[o + 2] as number) * a;
			}
			if (aSum === 0) continue;
			const d = ((j * half + py) * tileSize + i * half + px) * 4;
			parent[d] = Math.round(r / aSum);
			parent[d + 1] = Math.round(g / aSum);
			parent[d + 2] = Math.round(b / aSum);
			parent[d + 3] = Math.round(aSum / 4);
		}
	}
}

export async function decodeRaw(
	input: Buffer | string,
): Promise<{ data: Buffer; width: number; height: number }> {
	const { data, info } = await sharp(input)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

export async function loadTile(
	blobs: BlobStore,
	hash: string,
	tileSize: number,
): Promise<Buffer> {
	const { data, width, height } = await decodeRaw(await blobs.read(hash));
	if (width !== tileSize || height !== tileSize) {
		throw new Error(
			`blob ${hash} is ${width}x${height}, expected ${tileSize}x${tileSize}`,
		);
	}
	return data;
}

/** Encodes a tile as lossless WebP. Returns null when it is fully transparent. */
export async function encodeTile(
	rgba: Buffer,
	tileSize: number,
): Promise<Buffer | null> {
	if (isEmpty(rgba)) return null;
	// Colour under transparent pixels is meaningless; zero it so equal tiles hash equally.
	for (let i = 0; i < rgba.length; i += 4) {
		if (rgba[i + 3] === 0) {
			rgba[i] = 0;
			rgba[i + 1] = 0;
			rgba[i + 2] = 0;
		}
	}
	return sharp(rgba, {
		raw: { width: tileSize, height: tileSize, channels: 4 },
	})
		.webp({ lossless: true, exact: true })
		.toBuffer();
}

/** Stores a tile as lossless WebP. Returns null (and stores nothing) when it is fully transparent. */
export async function storeTile(
	blobs: BlobStore,
	rgba: Buffer,
	tileSize: number,
): Promise<string | null> {
	const webp = await encodeTile(rgba, tileSize);
	return webp ? blobs.put(webp) : null;
}
