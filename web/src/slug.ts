/** "The Nether" -> "the_nether": lowercase letters, digits, - and _ only, at most 40 characters. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
}
