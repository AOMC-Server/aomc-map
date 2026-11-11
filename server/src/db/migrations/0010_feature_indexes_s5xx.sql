ALTER TABLE `traffic_hourly` ADD `s5xx` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `feature_revisions_author` ON `feature_revisions` (`author_id`);--> statement-breakpoint
CREATE INDEX `features_layer_order` ON `features` (`layer_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `revisions_dimension_status` ON `revisions` (`dimension_id`,`status`);--> statement-breakpoint
CREATE INDEX `revisions_author` ON `revisions` (`author_id`);--> statement-breakpoint
CREATE INDEX `upload_patches_tile` ON `upload_patches` (`tile_x`,`tile_y`);