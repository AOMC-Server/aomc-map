CREATE TABLE `short_links` (
	`code` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `short_links_query_unique` ON `short_links` (`query`);