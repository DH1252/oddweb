CREATE TABLE `guestbook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guestbook_created_idx` ON `guestbook` (`created_at`);--> statement-breakpoint
CREATE TABLE `site_tags` (
	`site_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`raw_name` text NOT NULL,
	PRIMARY KEY(`site_id`, `raw_name`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_tags_tag_idx` ON `site_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`poster` text DEFAULT 'NEW FIND' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`facts` text DEFAULT '[]' NOT NULL,
	`accent` text DEFAULT 'from-[#63396d] to-[#d27a3e]' NOT NULL,
	`thumbnail_key` text,
	`thumbnail_alt` text,
	`visits` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text DEFAULT 'Manual' NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_unique` ON `sites` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_unique` ON `sites` (`url`);--> statement-breakpoint
CREATE INDEX `sites_status_added_idx` ON `sites` (`status`,`added_at`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`thumbnail_key` text,
	`thumbnail_alt` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_url_unique` ON `submissions` (`url`);--> statement-breakpoint
CREATE INDEX `submissions_status_date_idx` ON `submissions` (`status`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `tag_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alias` text NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_aliases_alias_unique` ON `tag_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `tag_parents` (
	`parent_tag_id` integer NOT NULL,
	`child_tag_id` integer NOT NULL,
	PRIMARY KEY(`parent_tag_id`, `child_tag_id`),
	FOREIGN KEY (`parent_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'Topic' NOT NULL,
	`canonical` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
CREATE INDEX `tags_canonical_category_idx` ON `tags` (`canonical`,`category`);