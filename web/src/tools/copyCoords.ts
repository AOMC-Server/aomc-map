import { effect, signal } from "@preact/signals";
import type { MapView } from "../map/MapView";

export type Point = { x: number; z: number };

export const copiedPoints = signal<Point[]>([]);
export const copyStatus = signal<"idle" | "copied" | "failed">("idle");

const formatCoords = (points: Point[]) =>
	points.map((p) => `${p.x} ${p.z}`).join(", ");

export async function clickCopy(p: Point) {
	copiedPoints.value = [...copiedPoints.value, p];
	try {
		await navigator.clipboard.writeText(formatCoords(copiedPoints.value));
		copyStatus.value = "copied";
	} catch {
		copyStatus.value = "failed";
	}
}

export function clearCopy() {
	copiedPoints.value = [];
	copyStatus.value = "idle";
}

export function drawCopy(ctx: CanvasRenderingContext2D, map: MapView) {
	const points = copiedPoints.value;
	if (points.length === 0) return;
	ctx.save();
	ctx.font = "12px Minecraft, monospace";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	points.forEach((p, i) => {
		const s = map.blockToScreen(p.x + 0.5, p.z + 0.5);
		ctx.beginPath();
		ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
		ctx.fillStyle = "#3fa7ff";
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = "#000";
		ctx.stroke();
		ctx.fillStyle = "#000";
		ctx.fillText(String(i + 1), s.x, s.y + 1);
	});
	ctx.restore();
}

export function watchCopy(map: MapView) {
	return effect(() => {
		copiedPoints.value;
		map.invalidate();
	});
}
