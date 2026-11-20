/** Where the map viewer lives; "/" only redirects here. */
export const VIEWER_PATH = "/v2/";

/** The old viewer's Leaflet level for 1:1; its zoom grew towards closer views, ours grows away. */
const LEGACY_ONE_TO_ONE = 9;

/**
 * Turns the query string of an old (v1) link, `?dim=&x=&z=&zoom=` with a Leaflet zoom level,
 * into the current one. Anything but a full position (x, z and zoom) is left as it is.
 */
export function upgradeLegacyQuery(search: string): string {
	const q = new URLSearchParams(search);
	const zoom = q.get("zoom");
	if (zoom === null || !q.has("x") || !q.has("z")) return q.toString();
	const level = Number(zoom);
	if (zoom.trim() === "" || !Number.isFinite(level)) q.delete("zoom");
	else q.set("zoom", String(LEGACY_ONE_TO_ONE - level));
	return q.toString();
}

/** The viewer URL (path and query) an old link at "/" should go to. */
export function viewerUrlForRoot(search: string): string {
	const query = upgradeLegacyQuery(search);
	return query ? `${VIEWER_PATH}?${query}` : VIEWER_PATH;
}
