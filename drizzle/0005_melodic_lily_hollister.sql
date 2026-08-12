CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_pending_url_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_open_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_open_url_unique` ON `submissions` (`url`) WHERE "submissions"."status" IN ('pending', 'approved');
