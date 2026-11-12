import type { Db } from "./db/client";
import { dimensions } from "./db/schema";
import type { Services } from "./services";
import { mapSnapshot } from "./topics";

type Ctx = { var: { db: Db; svc: Pick<Services, "events"> } };

/** Tells followers that `GET /api/map` changed: settings, dimensions, roles. */
export const announceMap = (c: Ctx) =>
	c.var.svc.events.emit("map", mapSnapshot(c.var.db));

/** Tells followers that a dimension's layers or features changed, or who may see them. */
export const announceLayers = (c: Ctx, dimensionId: number) =>
	c.var.svc.events.emit("layers", dimensionId, {});

/** Tells followers that a dimension's upload log changed. */
export function announceUploads(c: Ctx, dimensionId: number | null) {
	if (dimensionId !== null) c.var.svc.events.emit("revisions", dimensionId, {});
}

/**
 * Something that every view depends on changed (roles, or who is behind what was added): the map,
 * and every dimension's layers and upload log, which show what the viewer may see and do.
 */
export function announceEverything(c: Ctx) {
	announceMap(c);
	for (const { id } of c.var.db
		.select({ id: dimensions.id })
		.from(dimensions)
		.all()) {
		announceLayers(c, id);
		announceUploads(c, id);
	}
}
