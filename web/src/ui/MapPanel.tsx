import { useState } from "preact/hooks";
import { addDimension, updateDimension, updateMapSettings } from "../sharing";
import { slugify } from "../slug";
import { currentMap, type Dimension, mapPanelOpen } from "../state";
import { InviteLinks } from "./InviteLinks";
import { MembersSection } from "./MembersSection";

type Tab = "settings" | "dimensions" | "members" | "invites";

const TAB_LABELS: Record<Tab, string> = {
	settings: "Settings",
	dimensions: "Dimensions",
	members: "Members",
	invites: "Invites",
};

function SettingsTab() {
	const detail = currentMap.value;
	const [name, setName] = useState(detail?.map.name ?? "");
	const [tile, setTile] = useState(String(detail?.map.tileSize ?? ""));
	const [busy, setBusy] = useState(false);
	if (!detail) return null;
	const empty = detail.map.headRev === 0;

	const save = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		const size = Number.parseInt(tile, 10);
		await updateMapSettings({
			name: name.trim(),
			...(empty && size !== detail.map.tileSize ? { tileSize: size } : {}),
		});
		setBusy(false);
	};

	return (
		<form class="settings-form" onSubmit={save}>
			<label class="field">
				<span class="label">Map name</span>
				<input
					type="text"
					value={name}
					maxLength={100}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				<span class="label">Tile size (blocks per tile edge)</span>
				<input
					type="text"
					inputMode="numeric"
					value={tile}
					disabled={!empty}
					onInput={(e) => setTile(e.currentTarget.value.replace(/\D/g, ""))}
				/>
				<span class="muted hint">
					{empty
						? "An even number from 16 to 2048. This can only be changed until the first upload."
						: "Locked: the map already has uploads, and tiles cannot be re-cut."}
				</span>
			</label>
			<p class="muted">
				Visibility: <b>{detail.map.visibility}</b>
				{detail.map.isDefault ? " (the main map is always public)" : ""}
			</p>
			<button type="submit" class="btn primary" disabled={busy || !name.trim()}>
				Save
			</button>
		</form>
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
	const prev = all[index - 1];
	const next = all[index + 1];

	const swap = (other: Dimension) =>
		props.run(async () => {
			// Give both a distinct, explicit position so ties never hide the move.
			const a = index;
			const b = all.indexOf(other);
			const ok1 = await updateDimension(d.slug, { sortOrder: b });
			const ok2 = await updateDimension(other.slug, { sortOrder: a });
			return ok1 && ok2;
		});

	return (
		<li class={d.archived ? "archived" : ""}>
			<div class="dim-main">
				<input
					type="text"
					value={name}
					maxLength={100}
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
			</div>
			<div class="group">
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !prev}
					aria-label="Move up"
					onClick={() => prev && swap(prev)}
				>
					↑
				</button>
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !next}
					aria-label="Move down"
					onClick={() => next && swap(next)}
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
	const [slugTouched, setSlugTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	if (!detail) return null;
	const dims = [...detail.dimensions].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
	);

	const run = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		await fn();
		setBusy(false);
	};

	const add = async (e: Event) => {
		e.preventDefault();
		const slug = newSlug || slugify(newName);
		if (!newName.trim() || !slug) return;
		await run(async () => {
			const ok = await addDimension(slug, newName.trim());
			if (ok) {
				setNewName("");
				setNewSlug("");
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
			<ul class="dimension-list">
				{dims.map((d, i) => (
					<DimensionRow
						key={`${d.slug}:${d.name}:${d.sortOrder}`}
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
					maxLength={100}
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
				<button
					type="submit"
					class="btn"
					disabled={busy || !newName.trim() || !newSlug}
				>
					Add
				</button>
			</form>
		</div>
	);
}

/** Map administration: settings, dimensions, members and invite links. */
export function MapPanel() {
	const detail = currentMap.value;
	const role = detail?.role;
	const tabs: Tab[] = [];
	if (role === "owner") tabs.push("settings");
	if (role === "owner" || (role === "moderator" && detail?.map.isDefault))
		tabs.push("dimensions");
	if (role === "owner") tabs.push("members", "invites");
	const [tab, setTab] = useState<Tab>(tabs[0] ?? "dimensions");
	const active = tabs.includes(tab) ? tab : tabs[0];

	return (
		<aside class="panel" aria-label="Map administration">
			<header class="panel-head">
				<h2>{detail?.map.name ?? "Map"}</h2>
				<button
					type="button"
					class="btn"
					aria-label="Close"
					onClick={() => (mapPanelOpen.value = false)}
				>
					×
				</button>
			</header>
			{tabs.length > 1 && (
				<div class="tabs" role="tablist">
					{tabs.map((t) => (
						<button
							key={t}
							type="button"
							role="tab"
							aria-selected={t === active}
							class={`tab ${t === active ? "active" : ""}`}
							onClick={() => setTab(t)}
						>
							{TAB_LABELS[t]}
						</button>
					))}
				</div>
			)}
			<div class="panel-body">
				{active === "settings" && <SettingsTab />}
				{active === "dimensions" && <DimensionsTab />}
				{active === "members" && <MembersSection scope={{ kind: "map" }} />}
				{active === "invites" && <InviteLinks scope={{ kind: "map" }} />}
				{!active && (
					<p class="muted">You don't have anything to manage on this map.</p>
				)}
			</div>
		</aside>
	);
}
