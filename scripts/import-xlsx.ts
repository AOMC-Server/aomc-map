import { parseArgs } from "node:util";
import * as XLSX from "xlsx";
import { DYES, type Dye } from "../shared/src/colors";
import {
	type FeatureInput,
	featureInputSchema,
	MAX_NAME,
	MAX_VERTICES,
} from "../shared/src/features";
import { orExit } from "./args";

/**
 * Imports a spreadsheet of features through the public API only.
 *
 * Every sheet is a layer, unless its name contains "!". The sheet name carries the settings:
 * `@<dimension>` at the start picks the dimension (default overworld), a `.` at the start hides
 * the layer by default, and `#<color>` at the end sets its colour, e.g. `.@nether Farms #red`.
 * Rows are `name | type | popup | coordinates`, where type is Pin, Line or Polygon and the
 * coordinates are `x z, x z, ...`. A `#<color>` at the end of a feature's name colours it.
 *
 * A layer is found by dimension and name; it is created if missing and its features are
 * replaced by the sheet's rows (replacing needs the layer's creator or a moderator).
 */

export type ParsedLayer = {
	sheet: string;
	dimension: string;
	name: string;
	color: Dye;
	hiddenByDefault: boolean;
	features: FeatureInput[];
	warnings: string[];
};

export type ImportOptions = {
	url: string;
	token: string;
	file: string;
	/** Dimension name in a sheet name -> dimension slug, when they differ. */
	dimMap?: Record<string, string>;
	defaultDimension?: string;
	/** Only these sheets (by exact sheet name). */
	sheets?: string[];
	dryRun?: boolean;
	retryMs?: number;
	fetch?: typeof fetch;
	log?: (message: string) => void;
};

export type ImportResult = {
	layers: number;
	created: number;
	features: number;
	skippedRows: number;
};

const TYPES = { pin: "pin", line: "line", polygon: "polygon" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A colour name, or the start of one when Excel cut the sheet name off at 31 characters. */
export function matchDye(text: string): Dye | undefined {
	const t = text.trim().toLowerCase().replaceAll(" ", "_");
	if (!t) return undefined;
	const exact = DYES.find((d) => d === t);
	if (exact) return exact;
	const starts = DYES.filter((d) => d.startsWith(t));
	return starts.length === 1 ? starts[0] : undefined;
}

/** Splits `#color` off the end of a name. A trailing `#word` that is no colour stays in the name. */
export function splitColor(raw: string): { name: string; color?: Dye } {
	const m = /^(.*?)\s*#([A-Za-z_ ]*)$/.exec(raw.trim());
	if (!m) return { name: raw.trim() };
	const color = matchDye(m[2] as string);
	// A bare "#" (a colour cut off by Excel's 31 character sheet names) is dropped too.
	return color || !m[2]?.trim()
		? { name: (m[1] as string).trim(), color }
		: { name: raw.trim() };
}

export function parseSheetName(
	sheet: string,
	defaultDimension = "overworld",
	dimMap: Record<string, string> = {},
) {
	let rest = sheet.trim();
	let hiddenByDefault = false;
	let dimension = defaultDimension;
	// "." and "@<dimension>" may come in either order.
	for (let i = 0; i < 2; i++) {
		if (rest.startsWith(".")) {
			hiddenByDefault = true;
			rest = rest.slice(1).trim();
		}
		const dim = /^@(\S+)\s*/.exec(rest);
		if (dim) {
			dimension = dimMap[dim[1] as string] ?? (dim[1] as string);
			rest = rest.slice(dim[0].length);
		}
	}
	const { name, color } = splitColor(rest);
	return { dimension, name, color, hiddenByDefault };
}

export function parseCoords(text: string): [number, number][] | undefined {
	const points: [number, number][] = [];
	for (const part of text.split(",")) {
		if (part.trim() === "") continue;
		const nums = part.trim().split(/\s+/).map(Number);
		if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n)))
			return undefined;
		points.push([Math.round(nums[0] as number), Math.round(nums[1] as number)]);
	}
	return points.length > 0 ? points : undefined;
}

const cell = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function parseSheet(
	sheet: string,
	rows: unknown[][],
	defaultDimension?: string,
	dimMap?: Record<string, string>,
): ParsedLayer {
	const meta = parseSheetName(sheet, defaultDimension, dimMap);
	const warnings: string[] = [];
	if (!meta.color)
		warnings.push('no valid "#<color>" in the sheet name, using white');
	const features: FeatureInput[] = [];

	for (const [i, row] of rows.entries()) {
		const at = `row ${i + 1}`;
		const type = TYPES[cell(row[1]).trim().toLowerCase() as keyof typeof TYPES];
		if (!type) {
			if (i > 0 && row.some((v) => cell(v).trim() !== ""))
				warnings.push(`${at}: unknown type "${cell(row[1])}", skipped`);
			continue;
		}
		const { name, color } = splitColor(cell(row[0]));
		let popup = cell(row[2]);
		let coordText = cell(row[3]);
		// Without a coordinates cell, the popup cell may hold them.
		if (!coordText.trim() && parseCoords(popup)) {
			coordText = popup;
			popup = "";
		}
		const points = parseCoords(coordText);
		if (!points) {
			warnings.push(`${at} (${name}): cannot read coordinates, skipped`);
			continue;
		}
		const first = points[0];
		const last = points[points.length - 1];
		// A polygon closes itself; a repeated first point only adds a zero-length edge.
		if (
			type === "polygon" &&
			points.length > 3 &&
			first &&
			last &&
			first[0] === last[0] &&
			first[1] === last[1]
		)
			points.pop();

		// A line over the vertex limit becomes consecutive lines that share their end points.
		const parts: [number, number][][] = [];
		if (type === "line" && points.length > MAX_VERTICES) {
			for (let s = 0; s < points.length - 1; s += MAX_VERTICES - 1)
				parts.push(points.slice(s, s + MAX_VERTICES));
			warnings.push(
				`${at} (${name}): ${points.length} points, split into ${parts.length} lines`,
			);
		} else parts.push(points);

		for (const [n, part] of parts.entries()) {
			const label = parts.length > 1 ? ` (${n + 1}/${parts.length})` : "";
			const parsed = featureInputSchema.safeParse({
				type,
				name: `${name.slice(0, MAX_NAME - label.length)}${label}`,
				popup,
				color: color ?? null,
				geometry: type === "pin" ? part[0] : part,
			});
			if (!parsed.success) {
				const why = parsed.error.issues[0]?.message ?? "invalid";
				warnings.push(`${at} (${name}): ${why}, skipped`);
				continue;
			}
			features.push(parsed.data);
		}
	}
	return {
		sheet,
		dimension: meta.dimension,
		name: meta.name,
		color: meta.color ?? "white",
		hiddenByDefault: meta.hiddenByDefault,
		features,
		warnings,
	};
}

/** Every layer sheet of the workbook (sheets with "!" in the name are not layers). */
export function parseWorkbook(
	file: string,
	opts: Pick<ImportOptions, "defaultDimension" | "dimMap" | "sheets"> = {},
): ParsedLayer[] {
	const wb = XLSX.readFile(file);
	return wb.SheetNames.filter(
		(n) => !n.includes("!") && (!opts.sheets || opts.sheets.includes(n)),
	).map((n) =>
		parseSheet(
			n,
			XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n] as XLSX.WorkSheet, {
				header: 1,
				defval: "",
			}),
			opts.defaultDimension,
			opts.dimMap,
		),
	);
}

type ApiLayer = {
	id: number;
	name: string;
	color: string;
	hiddenByDefault: boolean;
};

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
	const f = opts.fetch ?? fetch;
	const log = opts.log ?? console.log;
	const base = opts.url.replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${opts.token}`,
		"Content-Type": "application/json",
	};

	const parsed = parseWorkbook(opts.file, opts);
	if (parsed.length === 0) throw new Error("no layer sheets found");

	async function call(method: string, path: string, body?: unknown) {
		for (let attempt = 0; ; attempt++) {
			const res = await f(`${base}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (res.status === 429 && attempt < 20) {
				log("rate limited, waiting");
				await sleep(opts.retryMs ?? 15_000);
				continue;
			}
			const json = (await res.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			if (!res.ok)
				throw new Error(
					`${method} ${path} failed (HTTP ${res.status}): ${String(json.error ?? "unknown error")}`,
				);
			return json;
		}
	}

	const mapRes = await f(`${base}/api/map`, { headers });
	if (!mapRes.ok)
		throw new Error(`cannot open the map (HTTP ${mapRes.status})`);
	const map = (await mapRes.json()) as { dimensions: { slug: string }[] };
	const known = new Set(map.dimensions.map((d) => d.slug));
	const missing = [...new Set(parsed.map((l) => l.dimension))].filter(
		(d) => !known.has(d),
	);
	if (missing.length > 0)
		throw new Error(
			`dimension${missing.length > 1 ? "s" : ""} ${missing.map((s) => `"${s}"`).join(", ")} ` +
				"not on the map; add them in Manage > Dimensions first, or rename with --dim-map",
		);

	const result: ImportResult = {
		layers: 0,
		created: 0,
		features: 0,
		skippedRows: 0,
	};
	const existing = new Map<string, ApiLayer[]>();
	for (const dim of new Set(parsed.map((l) => l.dimension))) {
		const { layers } = (await call(
			"GET",
			`/api/layers?dim=${encodeURIComponent(dim)}`,
		)) as { layers: ApiLayer[] };
		existing.set(dim, layers);
	}

	for (const layer of parsed) {
		for (const w of layer.warnings) log(`${layer.sheet}: ${w}`);
		result.skippedRows += layer.warnings.filter((w) =>
			w.endsWith("skipped"),
		).length;
		if (layer.name === "") {
			log(`${layer.sheet}: no layer name left after the settings, skipped`);
			continue;
		}
		const found = existing
			.get(layer.dimension)
			?.find((l) => l.name === layer.name);
		const what = `${layer.dimension}/${layer.name}`;
		if (opts.dryRun) {
			log(
				`${what}: would ${found ? "replace" : "create and fill"} with ${layer.features.length} features`,
			);
			result.layers++;
			result.features += layer.features.length;
			continue;
		}

		let id: number;
		if (found) {
			id = found.id;
			if (
				found.color !== layer.color ||
				found.hiddenByDefault !== layer.hiddenByDefault
			)
				await call("PATCH", `/api/layers/${id}`, {
					color: layer.color,
					hiddenByDefault: layer.hiddenByDefault,
				});
		} else {
			const out = (await call("POST", "/api/layers", {
				dimension: layer.dimension,
				name: layer.name,
				color: layer.color,
				hiddenByDefault: layer.hiddenByDefault,
			})) as { layer: ApiLayer };
			id = out.layer.id;
			result.created++;
		}
		await call("POST", `/api/layers/${id}/import?replace=1`, layer.features);
		result.layers++;
		result.features += layer.features.length;
		log(
			`${what}: ${found ? "updated" : "created"}, ${layer.features.length} features`,
		);
	}
	return result;
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			url: { type: "string" },
			token: { type: "string", default: process.env.AOMC_TOKEN },
			file: { type: "string" },
			sheet: { type: "string", multiple: true },
			dimension: { type: "string", default: "overworld" },
			"dim-map": { type: "string", multiple: true },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.url || !values.token || !values.file) {
		console.error(
			"usage: bun scripts/import-xlsx.ts --url https://map.example.com --token aomc_... --file features.xlsx\n" +
				"       [--sheet 'Sheet name'] [--dimension overworld] [--dim-map name=slug] [--dry-run]\n" +
				"       (the token can also come from the AOMC_TOKEN environment variable)",
		);
		process.exit(2);
	}
	const dimMap = Object.fromEntries(
		(values["dim-map"] ?? []).map(
			(pair) => pair.split("=", 2) as [string, string],
		),
	);
	orExit(() => {
		if (Object.values(dimMap).some((v) => !v))
			throw new Error("--dim-map must look like name=slug");
	});
	try {
		const r = await runImport({
			url: values.url,
			token: values.token,
			file: values.file,
			sheets: values.sheet,
			defaultDimension: values.dimension,
			dimMap,
			dryRun: values["dry-run"],
		});
		console.log(
			`done: ${r.layers} layers (${r.created} new), ${r.features} features, ${r.skippedRows} rows skipped`,
		);
	} catch (err) {
		console.error(
			`import stopped: ${err instanceof Error ? err.message : err}`,
		);
		process.exit(1);
	}
}
