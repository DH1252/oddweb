CREATE TABLE `site_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`visitor_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_votes_visitor_unique` ON `site_votes` (`site_id`,`visitor_key`);--> statement-breakpoint
CREATE INDEX `site_votes_site_idx` ON `site_votes` (`site_id`);