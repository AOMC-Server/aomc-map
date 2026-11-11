import type { Dye } from "@aomc/shared/colors";
import type { ComponentChildren } from "preact";
import { showNotice } from "../api";
import { currentMap, dimSlug } from "../state";
import { xaeroWaypoint } from "../waypoint";

/** Copies text to the clipboard, telling the user whether it worked. */
export async function copyText(text: string, done: string) {
	try {
		await navigator.clipboard.writeText(text);
		showNotice(done);
	} catch {
		showNotice(
			"Could not copy; select the text and copy it manually.",
			"error",
		);
	}
}

/** Copies a Xaero's Minimap waypoint for a block of the dimension being viewed. */
export function copyWaypoint(w: {
	name: string;
	x: number;
	z: number;
	color: Dye;
}) {
	const dim = currentMap.value?.dimensions.find(
		(d) => d.slug === dimSlug.value,
	);
	if (!dim) return;
	void copyText(
		xaeroWaypoint({ ...w, dimension: dim.xaeroDimension }),
		"Waypoint copied. Paste it in Minecraft chat to share it.",
	);
}

export type ExpiryOption = { label: string; value: number | null };

/** A choice of how long something lasts; `null` is "never". */
export function ExpirySelect(props: {
	options: ExpiryOption[];
	value: number | null;
	onChange: (value: number | null) => void;
}) {
	const key = (v: number | null) => (v === null ? "never" : String(v));
	return (
		<label>
			<span class="label">Expires</span>
			<select
				value={key(props.value)}
				onChange={(e) =>
					props.onChange(
						e.currentTarget.value === "never"
							? null
							: Number(e.currentTarget.value),
					)
				}
			>
				{props.options.map((x) => (
					<option key={x.label} value={key(x.value)}>
						{x.label}
					</option>
				))}
			</select>
		</label>
	);
}

/** A secret that is only shown once, right after it was created, with a copy button. */
export function ShownOnce(props: {
	intro: ComponentChildren;
	value: string;
	label: string;
	copied: string;
	onDone?: () => void;
}) {
	return (
		<div class="new-link">
			<p class="muted">{props.intro}</p>
			<div class="link-row">
				<input
					type="text"
					readOnly
					value={props.value}
					aria-label={props.label}
					onFocus={(e) => e.currentTarget.select()}
				/>
				<button
					type="button"
					class="btn"
					onClick={() => void copyText(props.value, props.copied)}
				>
					Copy
				</button>
				{props.onDone && (
					<button type="button" class="btn" onClick={props.onDone}>
						Done
					</button>
				)}
			</div>
		</div>
	);
}
