ALTER TABLE `dimensions` ADD `scale` real;--> statement-breakpoint
-- Existing installs: give the standard dimensions their usual scales (the End stays unrelated).
UPDATE `dimensions` SET `scale` = 1 WHERE `slug` IN ('overworld', 'overworld_caves');--> statement-breakpoint
UPDATE `dimensions` SET `scale` = 8 WHERE `slug` = 'nether';
