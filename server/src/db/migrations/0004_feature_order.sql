ALTER TABLE `features` ADD `sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing features keep the order they were listed in so far: by id.
UPDATE `features` SET `sort_order` = `id`;
