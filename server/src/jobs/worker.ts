import { rm } from "node:fs/promises";
import { asc, eq } from "drizzle-orm";
import { jobs, revisions } from "../db/schema";
import { failRevision } from "../tiles/history";
import { eraseUpload } from "./eraseUpload";
import { processUpload } from "./processUpload";
import {
	type EraseUploadPayload,
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
} from "./types";

const MAX_ATTEMPTS = 3;

/** Runs persisted jobs one at a time, in id order. */
export function createWorker(ctx: JobContext) {
	const { db, env, progress } = ctx;
	let running: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;

	async function runJob(job: typeof jobs.$inferSelect) {
		const payload = job.payload as { revisionId: number };
		const isErase = job.type === "erase_upload";
		await db
			.update(jobs)
			.set({ status: "processing", attempts: job.attempts + 1 })
			.where(eq(jobs.id, job.id));
		await db
			.update(revisions)
			.set(
				isErase
					? { status: "processing", error: null }
					: { status: "processing" },
			)
			.where(eq(revisions.id, payload.revisionId));
		progress.emit(payload.revisionId, {
			status: "processing",
			message: "started",
		});
		try {
			if (job.type === "process_upload") {
				await processUpload(ctx, job.payload as ProcessUploadPayload);
			} else if (job.type === "erase_upload") {
				await eraseUpload(ctx, job.payload as EraseUploadPayload);
			} else {
				throw new Error(`unknown job type ${job.type}`);
			}
			await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
			const [rev] = await db
				.select({ rev: revisions.rev })
				.from(revisions)
				.where(eq(revisions.id, payload.revisionId));
			progress.emit(payload.revisionId, {
				status: "done",
				rev: rev?.rev ?? null,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`job ${job.id} failed:`, err);
			await db
				.update(jobs)
				.set({ status: "failed" })
				.where(eq(jobs.id, job.id));
			if (isErase) {
				// The upload is still there, as it was.
				await db
					.update(revisions)
					.set({
						status: "done",
						error: `delete failed: ${message}`.slice(0, 500),
					})
					.where(eq(revisions.id, payload.revisionId));
			} else {
				await failRevision(db, payload.revisionId, message);
			}
			progress.emit(payload.revisionId, { status: "failed", error: message });
		} finally {
			await rm(incomingDir(env, payload.revisionId), {
				recursive: true,
				force: true,
			});
		}
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
					await runJob(job);
				}
			} finally {
				running = null;
			}
		})();
		return running;
	}

	return {
		run,
		kick() {
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
				const { revisionId } = job.payload as { revisionId: number };
				const isErase = job.type === "erase_upload";
				if (job.attempts >= MAX_ATTEMPTS) {
					db.update(jobs)
						.set({ status: "failed" })
						.where(eq(jobs.id, job.id))
						.run();
					db.update(revisions)
						.set(
							isErase
								? {
										status: "done",
										error: "delete failed: interrupted too many times",
									}
								: { status: "failed", error: "interrupted too many times" },
						)
						.where(eq(revisions.id, revisionId))
						.run();
				} else {
					db.update(jobs)
						.set({ status: "pending" })
						.where(eq(jobs.id, job.id))
						.run();
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
