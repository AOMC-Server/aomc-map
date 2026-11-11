import { computed, signal } from "@preact/signals";
import type { MapView } from "../map/MapView";

export type Point = { x: number; z: number };

export const measurePoints = signal<Point[]>([]);

export const measureResult = computed(() => {
	const [a, b] = measurePoints.value;
	if (!a || !b) return null;
	const dx = b.x - a.x;
	const dz = b.z - a.z;
	return { dx, dz, distance: Math.hypot(dx, dz) };
});

export function clickMeasure(p: Point) {
	const next = measurePoints.value.length >= 2 ? [] : measurePoints.value;
	measurePoints.value = [...next, p];
}

export function clearMeasure() {
	measurePoints.value = [];
}

export function drawMeasure(ctx: CanvasRenderingContext2D, map: MapView) {
	const points = measurePoints.value;
	if (points.length === 0) return;
	const screen = points.map((p) => map.blockToScreen(p.x + 0.5, p.z + 0.5));
	ctx.save();
	ctx.lineWidth = 2;
	ctx.strokeStyle = "#ffd23f";
	ctx.fillStyle = "#ffd23f";
	const [a, b] = screen;
	if (a && b) {
		ctx.setLineDash([6, 4]);
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		ctx.setLineDash([]);
		const result = measureResult.value;
		if (result) {
			const label = `${result.distance.toFixed(1)} blocks`;
			ctx.font = "13px Minecraft, monospace";
			const w = ctx.measureText(label).width + 10;
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			ctx.fillStyle = "rgba(0,0,0,0.75)";
			ctx.fillRect(mx - w / 2, my - 11, w, 22);
			ctx.fillStyle = "#ffd23f";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(label, mx, my);
		}
	}
	for (const s of screen) {
		ctx.beginPath();
		ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
		ctx.fillStyle = "#ffd23f";
		ctx.fill();
		ctx.strokeStyle = "#000";
		ctx.lineWidth = 1.5;
		ctx.stroke();
	}
	ctx.restore();
}
