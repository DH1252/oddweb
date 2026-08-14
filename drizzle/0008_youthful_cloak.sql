CREATE INDEX `public_rate_limits_window_started_idx` ON `public_rate_limits` (`window_started`);--> statement-breakpoint
CREATE INDEX `sites_status_visits_idx` ON `sites` (`status`,`visits`);--> statement-breakpoint
CREATE INDEX `sites_thumbnail_key_idx` ON `sites` (`thumbnail_key`) WHERE "sites"."thumbnail_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `submissions_thumbnail_key_idx` ON `submissions` (`thumbnail_key`) WHERE "submissions"."thumbnail_key" IS NOT NULL;