/** Values sampled at a time `t` (ms). */
export type Sample = { t: number; v: readonly number[] };

/**
 * How fast each value was changing (per ms): the slope of the least squares line through the
 * samples. Every sample counts, so one jittery reading (a finger rolling as it lifts, two events
 * handled in the same frame) only nudges the result instead of deciding it. Null when the
 * samples do not span any time.
 */
export function fitVelocity(samples: readonly Sample[]): number[] | null {
	const n = samples.length;
	if (n < 2) return null;
	let meanT = 0;
	for (const s of samples) meanT += s.t;
	meanT /= n;
	let stt = 0;
	for (const s of samples) stt += (s.t - meanT) ** 2;
	if (stt < 1e-9) return null;
	const dims = (samples[0] as Sample).v.length;
	const out: number[] = [];
	for (let d = 0; d < dims; d++) {
		let meanV = 0;
		for (const s of samples) meanV += s.v[d] as number;
		meanV /= n;
		let stv = 0;
		for (const s of samples)
			stv += (s.t - meanT) * ((s.v[d] as number) - meanV);
		out.push(stv / stt);
	}
	return out;
}
