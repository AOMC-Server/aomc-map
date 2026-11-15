CREATE TABLE `file_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`folder_id` integer,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`downloads` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `file_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `file_entries_folder` ON `file_entries` (`folder_id`);--> statement-breakpoint
CREATE INDEX `file_entries_hash` ON `file_entries` (`hash`);--> statement-breakpoint
CREATE TABLE `file_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `file_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `file_folders_parent` ON `file_folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `file_grants` (
	`folder_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`folder_id`, `user_id`),
	FOREIGN KEY (`folder_id`) REFERENCES `file_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_grants_user` ON `file_grants` (`user_id`);