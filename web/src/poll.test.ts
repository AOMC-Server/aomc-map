import { describe, expect, test } from "bun:test";
import { pollUntil } from "./poll";

describe("pollUntil", () => {
	test("returns the first result", async () => {
		let calls = 0;
		const out = await pollUntil(
			async () => (++calls === 3 ? "ready" : undefined),
			{ intervalMs: 1, timeoutMs: 1000 },
		);
		expect(out).toEqual({ done: true, value: "ready" });
		expect(calls).toBe(3);
	});

	test("gives up after the timeout", async () => {
		const out = await pollUntil(async () => undefined, {
			intervalMs: 5,
			timeoutMs: 30,
		});
		expect(out).toEqual({ done: false, reason: "timeout" });
	});

	test("stops when aborted", async () => {
		const ctl = new AbortController();
		let calls = 0;
		const out = await pollUntil(
			async () => {
				if (++calls === 2) ctl.abort();
				return undefined;
			},
			{ intervalMs: 5, timeoutMs: 60_000, signal: ctl.signal },
		);
		expect(out).toEqual({ done: false, reason: "aborted" });
		expect(calls).toBe(2);
	});
});
