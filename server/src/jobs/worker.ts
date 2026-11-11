import { rm } from "node:fs/promises";
import { asc, eq } from "drizzle-orm";
import { jobs, revisions } from "../db/schema";
import { failRevision } from "../tiles/history";
import { applyRevert } from "./applyRevert";
import { processUpload } from "./processUpload";
import {
	type ApplyRevertPayload,
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
} from "./types";

/** Runs persisted jobs one at a time, in id order. */
export function createWorker(ctx: JobContext) {
	const { db, env, progress } = ctx;
	let running: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;

	async function runJob(job: typeof jobs.$inferSelect) {
		const payload = job.payload as { revisionId: number };
		await db
			.update(jobs)
			.set({
				status: "processing",
				startedAt: Date.now(),
				attempts: job.attempts + 1,
			})
			.where(eq(jobs.id, job.id));
		await db
			.update(revisions)
			.set({ status: "processing" })
			.where(eq(revisions.id, payload.revisionId));
		progress.emit(payload.revisionId, {
			status: "processing",
			message: "started",
		});
		try {
			if (job.type === "process_upload") {
				await processUpload(ctx, job.payload as ProcessUploadPayload);
			} else {
				await applyRevert(ctx, job.payload as ApplyRevertPayload);
			}
			await db
				.update(jobs)
				.set({ status: "done", finishedAt: Date.now() })
				.where(eq(jobs.id, job.id));
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
				.set({
					status: "failed",
					finishedAt: Date.now(),
					error: message.slice(0, 500),
				})
				.where(eq(jobs.id, job.id));
			await failRevision(db, payload.revisionId, message);
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
		/** Jobs interrupted by a crash are retried; their results were never published. */
		start() {
			db.update(jobs)
				.set({ status: "pending" })
				.where(eq(jobs.status, "processing"))
				.run();
			db.update(revisions)
				.set({ status: "pending" })
				.where(eq(revisions.status, "processing"))
				.run();
			timer = setInterval(() => this.kick(), 5000);
			this.kick();
		},
		stop() {
			clearInterval(timer);
		},
	};
}
