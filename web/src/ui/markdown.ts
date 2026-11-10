export type Inline =
	| { kind: "text"; text: string }
	| { kind: "bold"; text: string }
	| { kind: "link"; text: string; href: string };

const TOKEN = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;

/** Only http(s) links are allowed; anything else (javascript:, data:, ...) is shown as plain text. */
export function safeHref(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
	} catch {
		return null;
	}
}

/** The popup markup subset: **bold**, [text](https://link) and line breaks. Never produces HTML. */
export function parseInline(line: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN)) {
		const at = m.index ?? 0;
		if (at > last) out.push({ kind: "text", text: line.slice(last, at) });
		if (m[1] !== undefined) {
			out.push({ kind: "bold", text: m[1] });
		} else {
			const href = safeHref(m[3] as string);
			out.push(
				href
					? { kind: "link", text: m[2] as string, href }
					: { kind: "text", text: m[0] },
			);
		}
		last = at + m[0].length;
	}
	if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
	return out;
}

export function parseText(text: string): Inline[][] {
	return text.split(/\r?\n/).map(parseInline);
}
