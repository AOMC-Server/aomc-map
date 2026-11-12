CREATE TABLE `tile_versions_rebuild` (
	`dimension_id` integer NOT NULL,
	`zoom` integer NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`rev` integer NOT NULL,
	`blob_hash` text,
	PRIMARY KEY(`dimension_id`, `zoom`, `tile_x`, `tile_y`, `rev`)
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `error` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `map_info` ADD `recompute_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `map_info` SET `recompute_pending` = 1 WHERE EXISTS (SELECT 1 FROM `revisions` WHERE `kind` <> 'upload' OR `reverted` = 1);--> statement-breakpoint
DELETE FROM `upload_patches` WHERE `revision_id` IN (SELECT `id` FROM `revisions` WHERE `kind` <> 'upload' OR `reverted` = 1);--> statement-breakpoint
DELETE FROM `upload_files` WHERE `revision_id` IN (SELECT `id` FROM `revisions` WHERE `kind` <> 'upload' OR `reverted` = 1);--> statement-breakpoint
DELETE FROM `jobs` WHERE json_extract(`payload`, '$.revisionId') IN (SELECT `id` FROM `revisions` WHERE `kind` <> 'upload' OR `reverted` = 1);--> statement-breakpoint
DELETE FROM `revisions` WHERE `kind` <> 'upload' OR `reverted` = 1;--> statement-breakpoint
ALTER TABLE `revisions` DROP COLUMN `target_revision_id`;--> statement-breakpoint
ALTER TABLE `revisions` DROP COLUMN `reverted`;