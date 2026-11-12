CREATE TABLE `upload_files` (
	`revision_id` integer NOT NULL,
	`dimension_id` integer NOT NULL,
	`x` integer NOT NULL,
	`z` integer NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dimension_id`) REFERENCES `dimensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upload_files_dimension_hash` ON `upload_files` (`dimension_id`,`hash`);--> statement-breakpoint
CREATE INDEX `upload_files_revision` ON `upload_files` (`revision_id`);