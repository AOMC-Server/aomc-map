/** Canvas drawing shared by the tools that draw on the map: the measure tool and feature placement. */

export const OUTLINE = "rgba(30, 30, 31, 0.9)";
const FONT = '600 12px "Noto Sans", "Segoe UI", system-ui, sans-serif';

type Pt = { x: number; y: number };

/** A line (or closed outline) with a dark edge, so that it reads on any terrain. */
export function outlinedPath(
	ctx: CanvasRenderingContext2D,
	pts: Pt[],
	opts: { color: string; width?: number; dashed?: boolean; closed?: boolean },
) {
	const width = opts.width ?? 2.5;
	ctx.beginPath();
	for (const [i, p] of pts.entries()) {
		if (i === 0) ctx.moveTo(p.x, p.y);
		else ctx.lineTo(p.x, p.y);
	}
	if (opts.closed) ctx.closePath();
	ctx.setLineDash(opts.dashed ? [8, 6] : []);
	ctx.lineWidth = width + 3.5;
	ctx.strokeStyle = OUTLINE;
	ctx.stroke();
	ctx.lineWidth = width;
	ctx.strokeStyle = opts.color;
	ctx.stroke();
	ctx.setLineDash([]);
}

/** A point handle: a square with a dark edge. */
export function handleSquare(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	half: number,
	fill: string,
) {
	const cx = Math.round(x);
	const cy = Math.round(y);
	ctx.fillStyle = OUTLINE;
	ctx.fillRect(cx - half - 2, cy - half - 2, half * 2 + 4, half * 2 + 4);
	ctx.fillStyle = fill;
	ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
}

/** A small "+" button, for handles that add a point. */
export function plusHandle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
) {
	const cx = Math.round(x);
	const cy = Math.round(y);
	ctx.fillStyle = OUTLINE;
	ctx.fillRect(cx - 7, cy - 7, 14, 14);
	ctx.fillStyle = "#58585a";
	ctx.fillRect(cx - 5, cy - 5, 10, 10);
	ctx.fillStyle = "#fff";
	ctx.fillRect(cx - 3, cy - 1, 6, 2);
	ctx.fillRect(cx - 1, cy - 3, 2, 6);
}

/** A dark label with a light outline, centred on (x, y). */
export function labelBox(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	color = "#fff",
) {
	ctx.font = FONT;
	const w = Math.ceil(ctx.measureText(text).width) + 12;
	const h = 20;
	const left = Math.round(x - w / 2);
	const top = Math.round(y - h / 2);
	ctx.fillStyle = "#1e1e1f";
	ctx.fillRect(left - 2, top - 2, w + 4, h + 4);
	ctx.fillStyle = "#313233";
	ctx.fillRect(left, top, w, h);
	ctx.fillStyle = color;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, left + w / 2, top + h / 2 + 1);
}
