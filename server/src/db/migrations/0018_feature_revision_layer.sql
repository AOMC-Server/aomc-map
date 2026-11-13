ALTER TABLE `feature_revisions` ADD `layer_id` integer REFERENCES layers(id);--> statement-breakpoint
UPDATE `feature_revisions` SET `layer_id` = (SELECT `layer_id` FROM `features` WHERE `features`.`id` = `feature_revisions`.`feature_id`);--> statement-breakpoint
CREATE INDEX `feature_revisions_layer` ON `feature_revisions` (`layer_id`);
