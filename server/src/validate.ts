import { validator } from "hono-openapi";

type Hook = NonNullable<Parameters<typeof validator>[2]>;

type Issue = {
	message: string;
	path?: readonly (PropertyKey | { key: PropertyKey })[];
};

/** The part of a validation issue that is safe and useful to send back. */
export const formatIssues = (issues: readonly Issue[]) =>
	issues.map((issue) => ({
		path: (issue.path ?? []).map((p) => (typeof p === "object" ? p.key : p)),
		message: issue.message,
	}));

const invalid: Hook = (result, c) => {
	if (result.success) return;
	return c.json(
		{ error: "invalid request", issues: formatIssues(result.error) },
		400,
	);
};

/** hono-openapi's validator, answering 400 `{ error, issues }` without echoing the request. */
export const validate = ((target, schema, hook, options) =>
	validator(
		target,
		schema,
		(hook ?? invalid) as typeof hook,
		options,
	)) as typeof validator;
