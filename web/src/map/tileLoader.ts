/**
 * Fetches a tile and decodes it. Browsers decode on the calling thread for `createImageBitmap`
 * (Firefox does for sure), which stalls panning and zooming, so this is done in a worker where
 * there is one. Resolves to null for an empty tile.
 */
let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<
	number,
	{ resolve: (b: ImageBitmap | null) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	if (typeof Worker === "undefined" || typeof document === "undefined") {
		worker = null;
		return worker;
	}
	try {
		const w = new Worker(new URL("./tileDecoder.worker.ts", import.meta.url), {
			type: "module",
		});
		w.onmessage = (e: MessageEvent) => {
			const job = waiting.get(e.data.id);
			if (!job) {
				(e.data.bitmap as ImageBitmap | undefined)?.close();
				return;
			}
			waiting.delete(e.data.id);
			if (e.data.error) job.reject(new Error(e.data.error));
			else job.resolve(e.data.bitmap);
		};
		w.onerror = () => {
			for (const job of waiting.values()) job.reject(new Error("tile worker"));
			waiting.clear();
			worker = null;
		};
		worker = w;
	} catch {
		worker = null;
	}
	return worker;
}

export async function loadTile(
	url: string,
	signal: AbortSignal,
): Promise<ImageBitmap | null> {
	const w = getWorker();
	if (!w) {
		const res = await fetch(url, { signal });
		if (res.status === 204) return null;
		if (!res.ok) throw new Error(`tile ${res.status}`);
		return createImageBitmap(await res.blob());
	}
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const abort = () => {
			if (!waiting.delete(id)) return;
			w.postMessage({ id, abort: true });
			reject(new DOMException("aborted", "AbortError"));
		};
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		waiting.set(id, {
			resolve: (b) => {
				signal.removeEventListener("abort", abort);
				resolve(b);
			},
			reject: (e) => {
				signal.removeEventListener("abort", abort);
				reject(e);
			},
		});
		w.postMessage({ id, url: new URL(url, location.href).href });
	});
}
