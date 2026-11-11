import { MAX_NAME } from "@aomc/shared/features";
import { canManage, canModerate } from "@aomc/shared/roles";
import {
	createDimensionSchema,
	DEFAULT_PRELOAD,
	DIMENSION_THEMES,
	type DimensionTheme,
	guessDimensionTheme,
	MAX_COORD,
	type PreloadRing,
} from "@aomc/shared/schemas";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { loginUrl } from "../api";
import { MAX_PRELOAD_TILES, preloadTiles } from "../map/tileLayer";
import { renumber } from "../reorder";
import { describeDimensionScale, formatScale, parseScale } from "../scale";
import {
	addDimension,
	mapScope,
	updateDimension,
	updateMapName,
} from "../sharing";
import { slugify } from "../slug";
import { currentMap, type Dimension, user } from "../state";
import { DIMENSION_THEME_NAMES } from "../theme";
import { AdminStats } from "./AdminStats";
import { InviteLinks } from "./InviteLinks";
import { BlockIcon } from "./icons";
import { MembersSection } from "./MembersSection";
import { LoadFailed, Page, usePageLoad } from "./Page";

type Tab = "settings" | "dimensions" | "members" | "invites" | "statistics";

const slugSchema = createDimensionSchema.shape.slug;

const TAB_LABELS: Record<Tab, string> = {
	settings: "Settings",
	dimensions: "Dimensions",
	members: "Members",
	invites: "Invites",
	statistics: "Statistics",
};

function SettingsTab() {
	const detail = currentMap.value;
	const [name, setName] = useState(detail?.map.name ?? "");
	const [busy, setBusy] = useState(false);
	if (!detail) return null;

	const save = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		try {
			await updateMapName(name.trim());
		} finally {
			setBusy(false);
		}
	};

	return (
		<form class="settings-form" onSubmit={save}>
			<label class="field">
				<span class="label">Map name</span>
				<input
					type="text"
					value={name}
					maxLength={MAX_NAME}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</label>
			<p class="muted hint">
				Tile size: {detail.map.tileSize} blocks per tile edge (fixed).
			</p>
			<button type="submit" class="btn primary" disabled={busy || !name.trim()}>
				Save
			</button>
		</form>
	);
}

function ThemeSelect(props: {
	value: DimensionTheme;
	label: string;
	disabled?: boolean;
	onChange: (theme: DimensionTheme) => void;
}) {
	return (
		<select
			class="theme-select"
			value={props.value}
			aria-label={props.label}
			disabled={props.disabled}
			onChange={(e) => props.onChange(e.currentTarget.value as DimensionTheme)}
		>
			{DIMENSION_THEMES.map((t) => (
				<option key={t} value={t}>
					{DIMENSION_THEME_NAMES[t]}
				</option>
			))}
		</select>
	);
}

const formatBlocks = (n: number) =>
	n >= 1000 && n % 1024 === 0 ? `${n / 1024}k` : String(n);

/** Accepts "2048", "2k" (2048) or "1.5k"; undefined if invalid. */
function parseBlocks(text: string): number | undefined {
	const m = /^\s*(\d+(?:\.\d+)?)\s*(k?)\s*$/i.exec(text);
	if (!m) return undefined;
	const n = Math.round(Number(m[1]) * (m[2] ? 1024 : 1));
	return n <= MAX_COORD ? n : undefined;
}

function PreloadRingRow(props: {
	ring: PreloadRing;
	slug: string;
	maxZoom: number;
	disabled: boolean;
	onChange: (ring: PreloadRing) => void;
	onRemove: () => void;
}) {
	const { ring } = props;
	const [radius, setRadius] = useState(formatBlocks(ring.radius));
	const levels = Array.from({ length: props.maxZoom + 1 }, (_, i) => i);
	return (
		<div class="preload-ring">
			<select
				value={ring.level}
				aria-label={`Preload resolution of ${props.slug}`}
				disabled={props.disabled}
				onChange={(e) =>
					props.onChange({ ...ring, level: Number(e.currentTarget.value) })
				}
			>
				{levels.map((l) => (
					<option key={l} value={l}>
						{l === 0 ? "Full" : `1/${2 ** l}`} resolution
					</option>
				))}
			</select>
			<span class="muted">within</span>
			<input
				type="text"
				inputMode="numeric"
				class="scale-input"
				value={radius}
				aria-label={`Preload radius of ${props.slug} in blocks`}
				disabled={props.disabled}
				onInput={(e) => setRadius(e.currentTarget.value)}
				onBlur={() => {
					const parsed = parseBlocks(radius);
					if (parsed === undefined || parsed === ring.radius) {
						setRadius(formatBlocks(ring.radius));
						return;
					}
					props.onChange({ ...ring, radius: parsed });
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
			<span class="muted">blocks of spawn</span>
			<button
				type="button"
				class="btn small"
				disabled={props.disabled}
				aria-label="Remove"
				onClick={props.onRemove}
			>
				✕
			</button>
		</div>
	);
}

/** The low resolution tiles viewers keep loaded around spawn (0, 0) in this dimension. */
function PreloadEditor(props: {
	d: Dimension;
	busy: boolean;
	run: (fn: () => Promise<boolean>) => void;
}) {
	const detail = currentMap.value;
	if (!detail) return null;
	const { d } = props;
	const rings = d.preload;
	const save = (preload: PreloadRing[]) =>
		props.run(() => updateDimension(d.slug, { preload }));
	const tiles = preloadTiles(rings, detail.map.tileSize, detail.maxZoom).length;
	const isDefault = JSON.stringify(rings) === JSON.stringify(DEFAULT_PRELOAD);
	const coarsest = Math.max(-1, ...rings.map((r) => r.level));

	return (
		<div class="dim-preload">
			<span class="muted">
				Preload around spawn:{" "}
				{rings.length === 0
					? "off"
					: `${tiles} tile${tiles === 1 ? "" : "s"}${tiles >= MAX_PRELOAD_TILES ? " (the most allowed; lower a radius or resolution)" : ""}`}
			</span>
			<div>
				{rings.map((ring, i) => (
					<PreloadRingRow
						key={`${i}:${ring.level}:${ring.radius}`}
						ring={ring}
						slug={d.slug}
						maxZoom={detail.maxZoom}
						disabled={props.busy}
						onChange={(next) => save(rings.map((r, j) => (j === i ? next : r)))}
						onRemove={() => save(rings.filter((_, j) => j !== i))}
					/>
				))}
			</div>
			<div class="group">
				<button
					type="button"
					class="btn small"
					disabled={props.busy || rings.length >= 8}
					onClick={() => {
						// A coarser ring reaching twice as far as the coarsest so far.
						const last = rings.find((r) => r.level === coarsest);
						const level = Math.min(coarsest + 1, detail.maxZoom);
						save([
							...rings,
							{
								level: Math.max(level, 0),
								radius: Math.min((last?.radius ?? 1024) * 2, MAX_COORD),
							},
						]);
					}}
				>
					Add ring
				</button>
				{!isDefault && (
					<button
						type="button"
						class="btn small"
						disabled={props.busy}
						onClick={() => save(DEFAULT_PRELOAD)}
					>
						Reset to default
					</button>
				)}
				{rings.length > 0 && (
					<button
						type="button"
						class="btn small"
						disabled={props.busy}
						onClick={() => save([])}
					>
						Turn off
					</button>
				)}
			</div>
		</div>
	);
}

function DimensionRow(props: {
	d: Dimension;
	index: number;
	all: Dimension[];
	busy: boolean;
	run: (fn: () => Promise<boolean>) => void;
}) {
	const { d, all, index } = props;
	const [name, setName] = useState(d.name);
	const [scale, setScale] = useState(formatScale(d.scale));
	const prev = all[index - 1];
	const next = all[index + 1];

	const move = (to: number) =>
		props.run(async () => {
			// Every dimension gets its position, so ties and gaps never hide the move.
			for (const { item, sortOrder } of renumber(all, index, to)) {
				if (!(await updateDimension(item.slug, { sortOrder }))) return false;
			}
			return true;
		});

	return (
		<li class={d.archived ? "archived" : ""}>
			<div class="dim-main">
				<input
					type="text"
					value={name}
					maxLength={MAX_NAME}
					aria-label={`Name of ${d.slug}`}
					onInput={(e) => setName(e.currentTarget.value)}
					onBlur={() => {
						const trimmed = name.trim();
						if (trimmed && trimmed !== d.name)
							props.run(() => updateDimension(d.slug, { name: trimmed }));
						else setName(d.name);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
				/>
				<span class="muted dim-slug">{d.slug}</span>
				<label class="dim-scale" title={describeDimensionScale(d.scale)}>
					<span class="muted">Scale ×</span>
					<input
						type="text"
						inputMode="decimal"
						placeholder="none"
						value={scale}
						aria-label={`Coordinate scale of ${d.slug}`}
						onInput={(e) => setScale(e.currentTarget.value)}
						onBlur={() => {
							const parsed = parseScale(scale);
							if (parsed === undefined || parsed === d.scale) {
								setScale(formatScale(d.scale));
								return;
							}
							props.run(() => updateDimension(d.slug, { scale: parsed }));
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
					/>
				</label>
				<div class="dim-scale">
					<span class="muted">Theme</span>
					<BlockIcon theme={d.theme} />
					<ThemeSelect
						value={d.theme}
						label={`Theme of ${d.slug}`}
						disabled={props.busy}
						onChange={(theme) =>
							props.run(() => updateDimension(d.slug, { theme }))
						}
					/>
				</div>
				<PreloadEditor d={d} busy={props.busy} run={props.run} />
			</div>
			<div class="group">
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !prev}
					aria-label="Move up"
					onClick={() => move(index - 1)}
				>
					↑
				</button>
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !next}
					aria-label="Move down"
					onClick={() => move(index + 1)}
				>
					↓
				</button>
				<button
					type="button"
					class="btn small"
					disabled={props.busy}
					onClick={() =>
						props.run(() => updateDimension(d.slug, { archived: !d.archived }))
					}
				>
					{d.archived ? "Restore" : "Archive"}
				</button>
			</div>
		</li>
	);
}

function DimensionsTab() {
	const detail = currentMap.value;
	const [newName, setNewName] = useState("");
	const [newSlug, setNewSlug] = useState("");
	const [newScale, setNewScale] = useState("");
	const [newTheme, setNewTheme] = useState<DimensionTheme | null>(null);
	const [slugTouched, setSlugTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	if (!detail) return null;
	const dims = [...detail.dimensions].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
	);

	const run = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	};

	const scale = parseScale(newScale);
	// Why the form cannot be submitted yet, once a name has been typed.
	const problem = !newName.trim()
		? null
		: !newSlug
			? "The slug is empty: type one using letters, digits, - or _."
			: !slugSchema.safeParse(newSlug).success
				? "The slug may only have lowercase letters, digits, - and _, and must start with a letter or digit."
				: scale === undefined
					? "The scale must be a positive number, or empty."
					: null;

	const add = async (e: Event) => {
		e.preventDefault();
		if (!newName.trim() || !newSlug || problem !== null || scale === undefined)
			return;
		const slug = newSlug;
		await run(async () => {
			const ok = await addDimension(
				slug,
				newName.trim(),
				scale,
				newTheme ?? guessDimensionTheme(slug),
			);
			if (ok) {
				setNewName("");
				setNewSlug("");
				setNewScale("");
				setNewTheme(null);
				setSlugTouched(false);
			}
			return ok;
		});
	};

	return (
		<div>
			<p class="muted">
				Archived dimensions disappear from the dimension picker but keep their
				tiles and history. Dimensions cannot be deleted.
			</p>
			<p class="muted">
				<b>Scale</b> relates a dimension's coordinates to the overworld: 1 for
				the overworld, 8 for the Nether (one Nether block is 8 overworld
				blocks). Switching between dimensions with a scale keeps showing the
				same place. Leave it empty for a dimension like the End, whose
				coordinates don't correspond to anything.
			</p>
			<p class="muted">
				<b>Theme</b> picks the dimension's icon and the colours of the interface
				while it is shown.
			</p>
			<p class="muted">
				<b>Preload around spawn</b> loads low resolution images of the area
				around 0, 0 in the background, so there is always something to show
				there while the detailed images load. Each ring keeps one resolution
				loaded out to a distance; a coarser ring can reach further for the same
				number of tiles. Viewers can turn preloading off in their settings.
			</p>
			<ul class="dimension-list">
				{dims.map((d, i) => (
					<DimensionRow
						key={`${d.slug}:${d.name}:${d.sortOrder}:${d.scale}`}
						d={d}
						index={i}
						all={dims}
						busy={busy}
						run={run}
					/>
				))}
			</ul>
			<form class="add-dimension" onSubmit={add}>
				<input
					type="text"
					placeholder="New dimension name"
					aria-label="New dimension name"
					value={newName}
					maxLength={MAX_NAME}
					onInput={(e) => {
						setNewName(e.currentTarget.value);
						if (!slugTouched) setNewSlug(slugify(e.currentTarget.value));
					}}
				/>
				<input
					type="text"
					placeholder="slug"
					aria-label="Dimension slug"
					value={newSlug}
					maxLength={40}
					onInput={(e) => {
						setSlugTouched(true);
						setNewSlug(e.currentTarget.value.toLowerCase());
					}}
				/>
				<input
					type="text"
					inputMode="decimal"
					class="scale-input"
					placeholder="scale"
					aria-label="Coordinate scale of the new dimension"
					value={newScale}
					onInput={(e) => setNewScale(e.currentTarget.value)}
				/>
				<ThemeSelect
					value={newTheme ?? guessDimensionTheme(newSlug)}
					label="Theme of the new dimension"
					onChange={setNewTheme}
				/>
				<button
					type="submit"
					class="btn"
					disabled={busy || !newName.trim() || problem !== null}
				>
					Add
				</button>
			</form>
			{problem && <p class="hint error-text">{problem}</p>}
		</div>
	);
}

/** /manage: map settings, dimensions, members, invite links and statistics, for moderators and owners. */
export function ManagePage() {
	const { status, retry } = usePageLoad();

	const detail = currentMap.value;
	const role = detail?.role;
	const tabs: Tab[] = [];
	if (role && canManage(role)) tabs.push("settings");
	if (role && canModerate(role)) tabs.push("dimensions");
	if (role && canManage(role)) tabs.push("members", "invites", "statistics");
	const [tab, setTab] = useState<Tab>("settings");
	const active = tabs.includes(tab) ? tab : tabs[0];

	let body: ComponentChildren;
	if (status === "loading") {
		body = <p class="muted">Loading…</p>;
	} else if (status === "failed") {
		body = <LoadFailed retry={retry} />;
	} else if (!detail) {
		body = <p class="error-text">The map could not be loaded.</p>;
	} else if (!user.value) {
		body = (
			<>
				<p>Log in to manage this map.</p>
				<a class="btn primary" href={loginUrl()}>
					Log in with Discord
				</a>
			</>
		);
	} else if (!active) {
		body = <p>Only moderators and owners can manage the map.</p>;
	} else {
		body = (
			<>
				<div class="tabs tabbar" role="tablist">
					{tabs.map((t) => (
						<button
							key={t}
							type="button"
							role="tab"
							aria-selected={t === active}
							class={`plain tab ${t === active ? "active" : ""}`}
							onClick={() => setTab(t)}
						>
							{TAB_LABELS[t]}
						</button>
					))}
				</div>
				<div class="page-section">
					{active === "settings" && <SettingsTab />}
					{active === "dimensions" && <DimensionsTab />}
					{active === "members" && <MembersSection scope={mapScope} />}
					{active === "invites" && <InviteLinks scope={mapScope} />}
					{active === "statistics" && <AdminStats />}
				</div>
			</>
		);
	}

	return (
		<Page title={detail ? `Manage ${detail.map.name}` : "Manage"}>{body}</Page>
	);
}
