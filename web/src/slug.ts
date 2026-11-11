/** "The Nether" -> "the_nether": lowercase letters, digits, - and _ only, at most 40 characters. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^[_-]+/, "")
		.slice(0, 40)
		.replace(/[_-]+$/, "");
}
