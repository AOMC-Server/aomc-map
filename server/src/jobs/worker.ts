import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { and, asc, eq, inArray } from "drizzle-orm";
import { jobs, revisions, tileVersionsRebuild } from "../db/schema";
import { recordStorage } from "../storage";
import { isPublished } from "../tiles/history";
import { mapSnapshot, recomputeSnapshot } from "../topics";
import { eraseUpload } from "./eraseUpload";
import { messages } from "./messages";
import { processUpload } from "./processUpload";
import { queueState } from "./queue";
import { type RecomputeProgress, recomputeHistory } from "./recomputeHistory";
import { throttled } from "./report";
import {
	type EraseUploadPayload,
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
	UserError,
} from "./types";

const MAX_ATTEMPTS = 3;

/** Runs persisted jobs one at a time, in id order. */
export function createWorker(ctx: JobContext) {
	const { db, env, events } = ctx;
	let running: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** How far a running history recompute is; null when none is running. */
	let recompute: RecomputeProgress | null = null;

	let lastQueue = "";
	/** Tells followers about the queue, when it changed since it last did. */
	const announceQueue = () => {
		const state = queueState(db);
		const json = JSON.stringify(state);
		if (json === lastQueue) return;
		lastQueue = json;
		events.emit("queue", state);
	};
	const announceRecompute = () =>
		events.emit("recompute", recomputeSnapshot(db, recompute));
	const announceMap = () => events.emit("map", mapSnapshot(db));

	const markJob = (id: number, status: "pending" | "done" | "failed") =>
		db.update(jobs).set({ status }).where(eq(jobs.id, id)).run();

	/**
	 * Fails a job and its revision. A failed erase leaves the upload as it was, with the reason
	 * in `error`.
	 */
	const failJob = (
		job: typeof jobs.$inferSelect,
		revisionId: number,
		message: string,
	) => {
		markJob(job.id, "failed");
		db.update(revisions)
			.set(
				job.type === "erase_upload"
					? {
							status: "done",
							error: `delete failed: ${message}`.slice(0, 500),
						}
					: {
							status: "failed",
							error: message.slice(0, 500),
							completedAt: Date.now(),
						},
			)
			.where(eq(revisions.id, revisionId))
			.run();
	};

	/** An upload whose revision was already published has nothing left to do; running it again would fail. */
	const alreadyPublished = (job: typeof jobs.$inferSelect) =>
		job.type === "process_upload" &&
		isPublished(db, (job.payload as { revisionId: number }).revisionId);

	/** A history recompute has no revision of its own: its state and error live on the job. */
	async function runRecompute(job: typeof jobs.$inferSelect) {
		db.update(jobs)
			.set({ status: "processing", attempts: job.attempts + 1, error: null })
			.where(eq(jobs.id, job.id))
			.run();
		recompute = { message: messages.starting };
		announceQueue();
		announceRecompute();
		const report = throttled((_: RecomputeProgress) => announceRecompute());
		let published = false;
		try {
			// Publishing marks the job done in the same transaction.
			await recomputeHistory(ctx, job.id, (p) => {
				recompute = p;
				report(p);
			});
			published = true;
		} catch (err) {
			console.error(`job ${job.id} failed:`, err);
			db.delete(tileVersionsRebuild).run();
			db.update(jobs)
				.set({
					status: "failed",
					error: (err instanceof UserError
						? err.message
						: "internal error"
					).slice(0, 500),
					completedAt: Date.now(),
				})
				.where(eq(jobs.id, job.id))
				.run();
		} finally {
			recompute = null;
			announceRecompute();
			announceQueue();
		}
		if (published) {
			announceMap();
			for (const dim of db
				.selectDistinct({ id: revisions.dimensionId })
				.from(revisions)
				.all())
				if (dim.id !== null) events.emit("revisions", dim.id, {});
		}
	}

	async function runJob(job: typeof jobs.$inferSelect) {
		if (job.type === "recompute_history") return runRecompute(job);
		const payload = job.payload as { revisionId: number };
		const isErase = job.type === "erase_upload";
		if (alreadyPublished(job)) {
			markJob(job.id, "done");
			announceQueue();
			await rm(incomingDir(env, payload.revisionId), {
				recursive: true,
				force: true,
			});
			return;
		}
		await db
			.update(jobs)
			.set({ status: "processing", attempts: job.attempts + 1 })
			.where(eq(jobs.id, job.id));
		// An erase only touches its target once it starts: until then the upload stays as it was.
		await db
			.update(revisions)
			.set(
				isErase
					? { status: "processing", error: null }
					: { status: "processing" },
			)
			.where(eq(revisions.id, payload.revisionId));
		// Read before an erase removes the revision.
		const dimension = db
			.select({ id: revisions.dimensionId })
			.from(revisions)
			.where(eq(revisions.id, payload.revisionId))
			.get()?.id;
		const announceDimension = () => {
			if (dimension != null) events.emit("revisions", dimension, {});
		};
		announceQueue();
		announceDimension();
		events.emit("revision", payload.revisionId, {
			status: "processing",
			message: messages.starting,
		});
		try {
			// Publishing marks the job done in the same transaction (an erase deletes its job row).
			if (job.type === "process_upload") {
				await processUpload(ctx, job.payload as ProcessUploadPayload, job.id);
			} else if (job.type === "erase_upload") {
				await eraseUpload(ctx, job.payload as EraseUploadPayload);
			} else {
				throw new Error(`unknown job type ${job.type}`);
			}
		} catch (err) {
			console.error(`job ${job.id} failed:`, err);
			if (!isErase && isPublished(db, payload.revisionId)) {
				// It was published after all; only what came after failed.
				markJob(job.id, "done");
			} else {
				const message =
					err instanceof UserError
						? err.message
						: isErase
							? "internal error"
							: "processing failed";
				failJob(job, payload.revisionId, message);
				announceQueue();
				announceDimension();
				events.emit("revision", payload.revisionId, {
					status: "failed",
					error: message,
				});
				await rm(incomingDir(env, payload.revisionId), {
					recursive: true,
					force: true,
				});
				return;
			}
		}

		// The result is published; nothing below may turn it into a failure.
		try {
			recordStorage(db, isErase ? "erase" : "upload");
			const [rev] = await db
				.select({ rev: revisions.rev })
				.from(revisions)
				.where(eq(revisions.id, payload.revisionId));
			announceQueue();
			announceDimension();
			announceMap();
			events.emit(
				"revision",
				payload.revisionId,
				rev ? { status: "done", rev: rev.rev } : { status: "gone" },
			);
		} catch (err) {
			console.error(`job ${job.id} finished, but afterwards:`, err);
		}
		await rm(incomingDir(env, payload.revisionId), {
			recursive: true,
			force: true,
		}).catch((err) => console.error("removing incoming files failed:", err));
	}

	/** Processes pending jobs until none are left. Concurrent callers share one loop. */
	function run(): Promise<void> {
		if (running) return running;
		running = (async () => {
			await null; // let `running` be assigned before the loop can clear it
			try {
				for (;;) {
					const job = db
						.select()
						.from(jobs)
						.where(eq(jobs.status, "pending"))
						.orderBy(asc(jobs.id))
						.limit(1)
						.get();
					if (!job) break;
					try {
						await runJob(job);
					} catch (err) {
						// Setup before the job's own error handling failed; don't leave it stuck.
						console.error(`job ${job.id} could not run:`, err);
						db.update(jobs)
							.set({
								status: "failed",
								error: "internal error",
								completedAt: Date.now(),
							})
							.where(
								and(
									eq(jobs.id, job.id),
									inArray(jobs.status, ["pending", "processing"]),
								),
							)
							.run();
					}
				}
			} finally {
				running = null;
			}
		})();
		return running;
	}

	return {
		run,
		/** Progress of the history recompute that is running, if one is. */
		recomputeProgress: () => recompute,
		/** Starts on queued jobs, and tells followers about the queue if it changed. */
		kick() {
			try {
				announceQueue();
			} catch (err) {
				console.error("announcing the queue failed:", err);
			}
			run().catch((err) => console.error("worker loop crashed:", err));
		},
		/**
		 * Jobs interrupted by a crash are retried, since their results were never published. One
		 * that keeps taking the process down is failed instead of crash-looping the server.
		 */
		start() {
			for (const job of db
				.select()
				.from(jobs)
				.where(eq(jobs.status, "processing"))
				.all()) {
				if (job.type === "recompute_history") {
					// Nothing of it was published; it starts over, unless it keeps crashing.
					db.update(jobs)
						.set(
							job.attempts >= MAX_ATTEMPTS
								? {
										status: "failed",
										error: "interrupted too many times",
										completedAt: Date.now(),
									}
								: { status: "pending" },
						)
						.where(eq(jobs.id, job.id))
						.run();
					continue;
				}
				const { revisionId } = job.payload as { revisionId: number };
				const isErase = job.type === "erase_upload";
				if (alreadyPublished(job)) {
					markJob(job.id, "done");
					rmSync(incomingDir(env, revisionId), {
						recursive: true,
						force: true,
					});
				} else if (job.attempts >= MAX_ATTEMPTS) {
					failJob(job, revisionId, "interrupted too many times");
					rmSync(incomingDir(env, revisionId), {
						recursive: true,
						force: true,
					});
				} else {
					markJob(job.id, "pending");
					db.update(revisions)
						.set({ status: isErase ? "done" : "pending" })
						.where(eq(revisions.id, revisionId))
						.run();
				}
			}
			timer = setInterval(() => this.kick(), 5000);
			this.kick();
		},
		stop() {
			clearInterval(timer);
		},
	};
}
