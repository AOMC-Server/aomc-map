/** Pure black means "no data" in Xaero exports. Mutates an RGBA buffer. */
export function blackToAlpha(rgba: Uint8Array): void {
	for (let i = 0; i < rgba.length; i += 4) {
		if (rgba[i] === 0 && rgba[i + 1] === 0 && rgba[i + 2] === 0)
			rgba[i + 3] = 0;
	}
}
