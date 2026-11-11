import { describe, expect, test } from "bun:test";
import { waypointInitials, xaeroWaypoint } from "./waypoint";

describe("xaero waypoints", () => {
	test("the chat text Xaero's Minimap understands", () => {
		expect(
			xaeroWaypoint({
				name: "Wool farm Portal",
				x: 83,
				z: 189,
				color: "yellow",
				dimension: "dim%-1",
			}),
		).toBe(
			"xaero-waypoint:Wool farm Portal:WF:83:~:189:14:false:0:Internal-dim%-1",
		);
	});

	test("colons in the name do not split the fields", () => {
		const text = xaeroWaypoint({
			name: "Base: north",
			x: -5,
			z: 0,
			color: "red",
			dimension: "dim%0",
		});
		expect(text).toBe(
			"xaero-waypoint:Base§§ north:BN:-5:~:0:12:false:0:Internal-dim%0",
		);
		expect(text.split(":")).toHaveLength(10);
	});

	test("a feature without a name still gets one", () => {
		expect(
			xaeroWaypoint({
				name: " ",
				x: 1,
				z: 2,
				color: "white",
				dimension: "dim%1",
			}),
		).toBe("xaero-waypoint:Waypoint:X:1:~:2:15:false:0:Internal-dim%1");
	});

	test("initials skip punctuation and keep letters outside ASCII", () => {
		expect(waypointInitials("wool")).toBe("W");
		expect(waypointInitials("(old) ärm farm")).toBe("OÄ");
		expect(waypointInitials("--- ...")).toBe("X");
	});
});
