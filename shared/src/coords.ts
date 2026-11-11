/** Floor division that rounds toward negative infinity (so -1 / 512 = -1). */
export function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}
