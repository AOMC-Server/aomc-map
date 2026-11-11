import { MAX_NAME } from "@aomc/shared/features";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "../api";
import { loadMapDetail, loadUser } from "../controller";
import { describeDimensionScale, formatScale, parseScale } from "../scale";
import {
	addDimension,
	mapScope,
	updateDimension,
	updateMapName,
} from "../sharing";
import { slugify } from "../slug";
import { currentMap, type Dimension, user } from "../state";
import { InviteLinks } from "./InviteLinks";
import { MembersSection } from "./MembersSection";
import { Page } from "./Page";

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
	const [busy, setBusy] = useState(false);
	if (!detail) return null;

	const save = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		await updateMapName(name.trim());
		setBusy(false);
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
	const [newScale, setNewScale] = useState("");
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
		const scale = parseScale(newScale);
		if (scale === undefined) return;
		await run(async () => {
			const ok = await addDimension(slug, newName.trim(), scale);
			if (ok) {
				setNewName("");
				setNewSlug("");
				setNewScale("");
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
				<button
					type="submit"
					class="btn"
					disabled={
						busy ||
						!newName.trim() ||
						!newSlug ||
						parseScale(newScale) === undefined
					}
				>
					Add
				</button>
			</form>
		</div>
	);
}

/** /manage: map settings, dimensions, members and invite links, for moderators and owners. */
export function ManagePage() {
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		void Promise.all([loadMapDetail(), loadUser()]).then(() => setLoaded(true));
	}, []);

	const detail = currentMap.value;
	const role = detail?.role;
	const tabs: Tab[] = [];
	if (role === "owner") tabs.push("settings");
	if (role === "owner" || role === "moderator") tabs.push("dimensions");
	if (role === "owner") tabs.push("members", "invites");
	const [tab, setTab] = useState<Tab>("settings");
	const active = tabs.includes(tab) ? tab : tabs[0];

	let body: ComponentChildren;
	if (!loaded) {
		body = <p class="muted">Loading…</p>;
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
				<div class="tabs" role="tablist">
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
				</div>
			</>
		);
	}

	return (
		<Page title={detail ? `Manage ${detail.map.name}` : "Manage"}>{body}</Page>
	);
}
