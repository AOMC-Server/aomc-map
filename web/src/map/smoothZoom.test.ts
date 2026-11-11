import { describe, expect, test } from "bun:test";
import { easeZoom } from "./smoothZoom";

describe("easeZoom", () => {
	test("moves toward the goal without overshooting, in both directions", () => {
		for (const goal of [3, -3]) {
			let z = 0;
			for (let i = 0; i < 10; i++) {
				const next = easeZoom(z, goal, 16, 80);
				expect(Math.abs(goal - next)).toBeLessThan(Math.abs(goal - z));
				expect(Math.sign(goal - next)).not.toBe(-Math.sign(goal));
				z = next;
			}
		}
	});

	test("arrives exactly, in a bounded number of frames", () => {
		let z = 0;
		let frames = 0;
		while (z !== 2 && frames < 1000) {
			z = easeZoom(z, 2, 16, 80);
			frames++;
		}
		expect(z).toBe(2);
		expect(frames).toBeLessThan(60);
	});

	test("does not depend on the frame rate", () => {
		const once = easeZoom(0, 1, 32, 80);
		const twice = easeZoom(easeZoom(0, 1, 16, 80), 1, 16, 80);
		expect(twice).toBeCloseTo(once, 9);
	});

	test("a frame of no time changes nothing", () => {
		expect(easeZoom(0.5, 2, 0, 80)).toBe(0.5);
		expect(easeZoom(0.5, 2, -5, 80)).toBe(0.5);
	});
});
