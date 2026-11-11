CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`reason` text NOT NULL,
	`blob_count` integer NOT NULL,
	`blob_bytes` integer NOT NULL,
	`referenced_blobs` integer NOT NULL,
	`referenced_bytes` integer NOT NULL,
	`db_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `traffic_hourly` (
	`hour` integer NOT NULL,
	`category` text NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`s2xx` integer DEFAULT 0 NOT NULL,
	`s3xx` integer DEFAULT 0 NOT NULL,
	`s4xx` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `category`, `domain`)
);
