CREATE TABLE `public_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`reservation_id` text NOT NULL,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `public_attempts_scope_key_time_idx` ON `public_attempts` (`action`,`scope`,`key`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `public_attempts_reservation_idx` ON `public_attempts` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `public_attempts_time_idx` ON `public_attempts` (`attempted_at`);--> statement-breakpoint
CREATE TABLE `turnstile_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`error_code` text NOT NULL,
 `attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turnstile_failures_time_idx` ON `turnstile_failures` (`attempted_at`);--> statement-breakpoint
CREATE TABLE `public_identity_activity` (
	`identity_key` text PRIMARY KEY NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`vote_changes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `public_identity_activity_last_seen_idx` ON `public_identity_activity` (`last_seen`);--> statement-breakpoint
ALTER TABLE `site_votes` ADD `identity_scheme` text DEFAULT 'ip-v0' NOT NULL;--> statement-breakpoint
ALTER TABLE `site_votes` ADD `voted` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `site_votes` ADD `quarantined` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `site_votes` ADD `updated_at` integer DEFAULT (unixepoch()) NOT NULL;--> statement-breakpoint
CREATE TABLE `vote_toggle_actions` (
	`request_id` text PRIMARY KEY NOT NULL,
	`site_id` integer NOT NULL,
	`visitor_key` text NOT NULL,
`status` text DEFAULT 'pending' NOT NULL,
	`voted` integer,
	`votes` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vote_toggle_actions_identity_idx` ON `vote_toggle_actions` (`visitor_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `vote_toggle_actions_time_idx` ON `vote_toggle_actions` (`created_at`);
