CREATE TABLE `public_submission_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `public_submission_attempts_key_time_idx` ON `public_submission_attempts` (`key`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `public_submission_attempts_time_idx` ON `public_submission_attempts` (`attempted_at`);