export type Point = { x: number; z: number };

/** True when both are the same block (or both absent). */
export function samePoint(a: Point | null, b: Point | null): boolean {
	return a === b || (!!a && !!b && a.x === b.x && a.z === b.z);
}

/** Lengths of the straight segments between consecutive points, in blocks. */
export function segmentLengths(points: Point[]): number[] {
	const out: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point;
		const b = points[i] as Point;
		out.push(Math.hypot(b.x - a.x, b.z - a.z));
	}
	return out;
}

/** The segments of a path as index pairs; `closed` also joins the last point back to the first. */
export function segmentIndices(
	count: number,
	closed = false,
): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 1; i < count; i++) out.push([i - 1, i]);
	if (closed && count > 2) out.push([count - 1, 0]);
	return out;
}

/** Length of the path through the points, in blocks; `closed` adds the way back to the start. */
export function pathLength(points: Point[], closed = false): number {
	let total = 0;
	for (const [a, b] of segmentIndices(points.length, closed)) {
		const p = points[a] as Point;
		const q = points[b] as Point;
		total += Math.hypot(q.x - p.x, q.z - p.z);
	}
	return total;
}

/** Area enclosed by the points (shoelace formula), in square blocks; 0 for fewer than three. */
export function polygonArea(points: Point[]): number {
	let sum = 0;
	for (const [a, b] of segmentIndices(points.length, true)) {
		const p = points[a] as Point;
		const q = points[b] as Point;
		sum += p.x * q.z - q.x * p.z;
	}
	return Math.abs(sum) / 2;
}

/** The block halfway between two points, rounded down to a whole block. */
export function midpoint(a: Point, b: Point): Point {
	return { x: Math.floor((a.x + b.x) / 2), z: Math.floor((a.z + b.z) / 2) };
}

const COMPASS = [
	"north",
	"north-east",
	"east",
	"south-east",
	"south",
	"south-west",
	"west",
	"north-west",
] as const;

/**
 * Which way a step of (dx, dz) points. North is -z and east is +x. `yaw` is the angle the F3
 * screen shows when facing that way: 0 is south, 90 west, ±180 north, -90 east.
 */
export function facing(dx: number, dz: number): { name: string; yaw: number } {
	const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
	const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
	const name = COMPASS[Math.round(bearing / 45) % 8] as string;
	// -180 and 180 are the same direction; F3 shows north as 180.
	return { name, yaw: yaw === -180 ? 180 : yaw + 0 };
}

/**
 * The point nearest to `to` that lies on a straight line from `from`: along x, along z, or on
 * a 45° diagonal. Used while Shift is held.
 */
export function snapToLine(from: Point, to: Point): Point {
	const dx = to.x - from.x;
	const dz = to.z - from.z;
	const d = Math.round((Math.abs(dx) + Math.abs(dz)) / 2);
	const candidates: Point[] = [
		{ x: to.x, z: from.z },
		{ x: from.x, z: to.z },
		{ x: from.x + Math.sign(dx) * d, z: from.z + Math.sign(dz) * d },
	];
	let best = candidates[0] as Point;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const dist = Math.hypot(c.x - to.x, c.z - to.z);
		if (dist < bestDist) {
			best = c;
			bestDist = dist;
		}
	}
	return best;
}

/** Ways to travel, with their speed in blocks per second (from the Minecraft wiki). */
export const TRAVEL_SPEEDS = [
	{ label: "Walking", speed: 4.317 },
	{ label: "Sprinting", speed: 5.612 },
	{ label: "Elytra with rockets", speed: 33.5 },
	{ label: "Boat on blue ice", speed: 72.73 },
] as const;

/** A duration in seconds as "45s", "3m 05s" or "2h 07m". */
export function formatDuration(seconds: number): string {
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
