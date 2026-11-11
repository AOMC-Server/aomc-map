ALTER TABLE `dimensions` ADD `theme` text DEFAULT 'overworld' NOT NULL;
--> statement-breakpoint
-- Existing dimensions get the theme their block icon was guessed from so far: by slug.
UPDATE `dimensions` SET `theme` = 'nether' WHERE `slug` LIKE '%nether%';
--> statement-breakpoint
UPDATE `dimensions` SET `theme` = 'end' WHERE `slug` LIKE '%end%' AND `slug` NOT LIKE '%nether%';
