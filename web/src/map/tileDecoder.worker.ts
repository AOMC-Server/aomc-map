/// <reference lib="webworker" />

type Job = { id: number; url: string } | { id: number; abort: true };

const pending = new Map<number, AbortController>();

self.onmessage = async (e: MessageEvent<Job>) => {
	const msg = e.data;
	if ("abort" in msg) {
		pending.get(msg.id)?.abort();
		return;
	}
	const { id, url } = msg;
	const abort = new AbortController();
	pending.set(id, abort);
	try {
		const res = await fetch(url, { signal: abort.signal });
		if (res.status === 204) {
			self.postMessage({ id: id, bitmap: null });
			return;
		}
		if (!res.ok) throw new Error(`tile ${res.status}`);
		const bitmap = await createImageBitmap(await res.blob());
		self.postMessage({ id: id, bitmap }, [bitmap]);
	} catch (err) {
		self.postMessage({ id: id, error: String(err) });
	} finally {
		pending.delete(id);
	}
};
