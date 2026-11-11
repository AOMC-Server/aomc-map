ALTER TABLE `dimensions` ADD `xaero_dimension` text DEFAULT 'dim%0' NOT NULL;
--> statement-breakpoint
-- Existing dimensions get the id that matches their theme, as new ones do.
UPDATE `dimensions` SET `xaero_dimension` = 'dim%-1' WHERE `theme` = 'nether';
--> statement-breakpoint
UPDATE `dimensions` SET `xaero_dimension` = 'dim%1' WHERE `theme` = 'end';
