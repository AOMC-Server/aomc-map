import { expect, test } from "bun:test";
import { failureMessage, inviteProblem } from "./errors";

test("shows the first validation issue with its path", () => {
	expect(
		failureMessage(400, {
			error: "invalid request",
			issues: [
				{ path: ["geometry", 0], message: "too big" },
				{ path: ["name"], message: "too long" },
			],
		}),
	).toBe("geometry.0: too big");
});

test("an issue without a path is just its message", () => {
	expect(
		failureMessage(400, {
			error: "invalid request",
			issues: [{ path: [], message: "nothing to update" }],
		}),
	).toBe("nothing to update");
});

test("rate limits and oversized requests get friendly messages", () => {
	expect(failureMessage(429, { error: "too many changes, slow down" })).toMatch(
		/Too many requests/,
	);
	expect(failureMessage(413, { error: "request body too large" })).toMatch(
		/too large/,
	);
});

test("falls back to the server's error, then the status", () => {
	expect(failureMessage(404, { error: "not found" })).toBe("not found");
	expect(failureMessage(500, null)).toBe("Request failed (500)");
});

const fail = (status: number, reason?: string) => ({
	status,
	error: "server text",
	detail: reason ? { reason } : null,
});

test("410 explains why the invite cannot be used", () => {
	expect(inviteProblem(fail(410, "expired"))).toMatch(/expired/);
	expect(inviteProblem(fail(410, "exhausted"))).toMatch(/used up/);
	expect(inviteProblem(fail(410, "revoked"))).toMatch(/withdrawn/);
});

test("410 without a known reason, or gone, is simply no longer valid", () => {
	expect(inviteProblem(fail(410, "gone"))).toBe(
		"This invite link is no longer valid.",
	);
	expect(inviteProblem(fail(410))).toBe("This invite link is no longer valid.");
});

test("other failures keep the server's message, unknown links say so", () => {
	expect(inviteProblem(fail(403))).toBe("server text");
	expect(inviteProblem(fail(404))).toBe("This invite link is not valid.");
});
