import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobs } from "../db/schema";
import type { QueueEvent } from "../events";
import { waitingMessage } from "./messages";
import { jobRevisionId } from "./target";

/** Ids of the uploads that have an erase queued or running. */
export function erasing(db: Db, ids?: number[]): Set<number> {
	return new Set(
		db
			.select({ id: jobRevisionId })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, "erase_upload"),
					inArray(jobs.status, ["pending", "processing"]),
					ids ? inArray(jobRevisionId, ids) : undefined,
				),
			)
			.all()
			.map((row) => row.id),
	);
}

/**
 * Why the revision's queued job has not started, or null when it has no queued job (it is
 * running, or finished): the history recompute in the way, or how many jobs are ahead of it.
 */
export function waiting(db: Db, revisionId: number): string | null {
	const job = db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobRevisionId, revisionId), eq(jobs.status, "pending")))
		.orderBy(desc(jobs.id))
		.get();
	if (!job) return null;
	return waitingMessage(
		db
			.select({ type: jobs.type, status: jobs.status })
			.from(jobs)
			.where(
				and(
					lt(jobs.id, job.id),
					inArray(jobs.status, ["pending", "processing"]),
				),
			)
			.orderBy(asc(jobs.id))
			.all(),
	);
}

/** How many jobs wait, and which one runs. */
export function queueState(db: Db): QueueEvent {
	const open = db
		.select({ type: jobs.type, status: jobs.status, revisionId: jobRevisionId })
		.from(jobs)
		.where(inArray(jobs.status, ["pending", "processing"]))
		.orderBy(asc(jobs.id))
		.all();
	const running = open.find((j) => j.status === "processing");
	return {
		pending: open.filter((j) => j.status === "pending").length,
		running: running
			? {
					type: running.type,
					revisionId:
						running.type === "recompute_history"
							? null
							: (running.revisionId as number | null),
				}
			: null,
	};
}
