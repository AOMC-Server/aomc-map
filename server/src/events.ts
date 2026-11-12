/**
 * What the server pushes to clients, by topic family. A topic is a family, or a family and a
 * key (`revision:12`, `layers:3`). Every push goes through one `EventHub`; `topics.ts` says how
 * each family is snapshotted and who may follow it, and `routes/events.ts` streams them.
 */

/** A revision's job: how far it is, and how it ended. `gone` = it no longer exists (erased). */
export type RevisionEvent =
	| {
			status: "pending" | "processing" | "done" | "failed";
			message?: string;
			done?: number;
			total?: number;
			rev?: number | null;
			error?: string | null;
	  }
	| { status: "gone" };

/** Kept for the job code: what a running job reports. */
export type ProgressEvent = Exclude<RevisionEvent, { status: "gone" }>;

/** The job queue: how many jobs wait, and which one runs. */
export type QueueEvent = {
	pending: number;
	running: {
		type: "process_upload" | "erase_upload" | "recompute_history";
		revisionId: number | null;
	} | null;
};

/** The newest history recompute (null if there never was one). */
export type RecomputeEvent = {
	recompute: {
		status: "pending" | "processing" | "done" | "failed";
		error: string | null;
		queuedAt: number;
		completedAt: number | null;
		progress: {
			message: string;
			done: number | null;
			total: number | null;
		} | null;
	} | null;
};

/** The parts of `GET /api/map` that change while the map is open. Any change, dimensions included, is announced. */
export type MapEvent = { headRev: number; epoch: number; maintenance: boolean };

/** Something in the keyed collection changed: fetch it again. Carries nothing, so it leaks nothing. */
export type Invalidation = Record<string, never>;

export type Events = {
	revision: RevisionEvent;
	revisions: Invalidation;
	layers: Invalidation;
	map: MapEvent;
	queue: QueueEvent;
	recompute: RecomputeEvent;
};

export type Family = keyof Events;
/** Families whose topics carry a key (a revision id or a dimension id). */
export const keyedFamilies = ["revision", "revisions", "layers"] as const;
export type KeyedFamily = (typeof keyedFamilies)[number];
type Args<F extends Family> = F extends KeyedFamily
	? [key: number, data: Events[F]]
	: [data: Events[F]];

export type Topic = {
	[F in Family]: F extends KeyedFamily ? `${F}:${number}` : F;
}[Family];

export const topicOf = <F extends Family>(family: F, key?: number): Topic =>
	(key === undefined ? family : `${family}:${key}`) as Topic;

/**
 * One message on the wire (`GET /api/events`). `seq` counts the topic's events since the server
 * started; a `snapshot` is the current state sent when you subscribe (or a refresh of it), and
 * carries the seq of the topic's last event so a reconnect can tell whether it missed any.
 */
export type Envelope =
	| {
			topic: Topic;
			seq: string;
			snapshot: boolean;
			/** The topic is done (a revision finished): this is its last event. */
			final?: true;
			data: Events[Family];
	  }
	| { topic: string; error: "not found" | "forbidden" | "unknown topic" };

/** What a topic's events carry. */
export type DataOf<T extends string> =
	T extends `${infer F extends Family}:${string}`
		? Events[F]
		: T extends Family
			? Events[T]
			: unknown;

type Listener = (data: never, seq: string) => void;

export type EventHub = ReturnType<typeof createEventHub>;

/** In-memory fan-out of everything the server pushes, keyed by topic. */
export function createEventHub() {
	const boot = Math.random().toString(36).slice(2, 8);
	const listeners = new Map<string, Set<Listener>>();
	const counts = new Map<string, number>();
	const seqOf = (topic: string) => `${boot}.${counts.get(topic) ?? 0}`;
	return {
		emit<F extends Family>(family: F, ...args: Args<F>) {
			const topic =
				args.length === 2 ? topicOf(family, args[0] as number) : family;
			const data = args.at(-1);
			counts.set(topic, (counts.get(topic) ?? 0) + 1);
			const seq = seqOf(topic);
			for (const fn of [...(listeners.get(topic) ?? [])])
				(fn as (data: unknown, seq: string) => void)(data, seq);
		},
		subscribe<T extends string>(
			topic: T,
			fn: (data: DataOf<T>, seq: string) => void,
		): () => void {
			const set = listeners.get(topic) ?? new Set();
			listeners.set(topic, set);
			set.add(fn as Listener);
			return () => {
				set.delete(fn as Listener);
				if (set.size === 0) listeners.delete(topic);
			};
		},
		/** The seq of the topic's last event, for snapshots. */
		seq: seqOf,
	};
}
