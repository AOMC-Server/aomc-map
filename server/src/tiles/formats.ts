import sharp from "sharp";

/**
 * Image formats the API can serve tiles in, for tools that cannot read lossless WebP or want
 * smaller files. Tiles are stored as lossless WebP; the others are converted from it on first
 * use and kept next to it as <sha256>.<suffix>.
 */
export const TILE_FORMATS = {
	webp: { suffix: "webp", type: "image/webp" },
	png: { suffix: "png", type: "image/png" },
	"png-black": { suffix: "black.png", type: "image/png" },
	"jpg-95": { suffix: "95.jpg", type: "image/jpeg" },
	"jpg-80": { suffix: "80.jpg", type: "image/jpeg" },
	"webp-lossy": { suffix: "lossy.webp", type: "image/webp" },
} as const;

export type TileFormat = keyof typeof TILE_FORMATS;
/** Formats made from the stored lossless WebP. */
export type DerivedFormat = Exclude<TileFormat, "webp">;

export function isTileFormat(value: string): value is TileFormat {
	return Object.hasOwn(TILE_FORMATS, value);
}

/** The format of a blob file name's suffix (after `<sha256>.`), or undefined. */
export function formatOfSuffix(suffix: string): TileFormat | undefined {
	return (Object.keys(TILE_FORMATS) as TileFormat[]).find(
		(f) => TILE_FORMATS[f].suffix === suffix,
	);
}

/** Converts a stored lossless WebP tile. JPEG and `png-black` have no transparency, so empty areas become black. */
export function transcode(
	webp: Buffer,
	format: DerivedFormat,
): Promise<Buffer> {
	const img = sharp(webp);
	switch (format) {
		case "png":
			return img.png().toBuffer();
		case "png-black":
			// Opaque RGB like the v1 map's tiles, which had no transparency.
			return img.flatten({ background: "#000000" }).png().toBuffer();
		case "jpg-95":
			// No chroma subsampling: it smears the sharp block edges of a map.
			return img
				.flatten({ background: "#000000" })
				.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
				.toBuffer();
		case "jpg-80":
			return img
				.flatten({ background: "#000000" })
				.jpeg({ quality: 80 })
				.toBuffer();
		case "webp-lossy":
			return img.webp({ quality: 80 }).toBuffer();
	}
}
