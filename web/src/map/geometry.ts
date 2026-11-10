export type Pt = readonly [number, number];
export type Bounds = { minX: number; minZ: number; maxX: number; maxZ: number };

/** Distance from point p to the segment a-b. */
export function distToSegment(
	px: number,
	pz: number,
	ax: number,
	az: number,
	bx: number,
	bz: number,
): number {
	const dx = bx - ax;
	const dz = bz - az;
	const len2 = dx * dx + dz * dz;
	const t =
		len2 === 0
			? 0
			: Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
	return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance from p to a polyline (or to the outline of a polygon when closed). */
export function distToPolyline(
	px: number,
	pz: number,
	pts: readonly Pt[],
	closed = false,
): number {
	let best = Number.POSITIVE_INFINITY;
	const n = pts.length;
	const last = closed ? n : n - 1;
	for (let i = 0; i < last; i++) {
		const a = pts[i] as Pt;
		const b = pts[(i + 1) % n] as Pt;
		best = Math.min(best, distToSegment(px, pz, a[0], a[1], b[0], b[1]));
	}
	return best;
}

/** Even-odd rule. */
export function pointInPolygon(
	px: number,
	pz: number,
	poly: readonly Pt[],
): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, zi] = poly[i] as Pt;
		const [xj, zj] = poly[j] as Pt;
		if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)
			inside = !inside;
	}
	return inside;
}

export function boundsOf(points: readonly Pt[]): Bounds {
	let minX = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const [x, z] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (z < minZ) minZ = z;
		if (z > maxZ) maxZ = z;
	}
	return { minX, minZ, maxX, maxZ };
}

export const intersects = (a: Bounds, b: Bounds) =>
	a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
