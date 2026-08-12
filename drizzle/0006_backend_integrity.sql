-- release: maintenance-required
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `submissions_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`url_key` text NOT NULL,
	`description` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`thumbnail_key` text,
	`thumbnail_alt` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reviewed_at` integer,
	CONSTRAINT `submissions_status_check` CHECK(`status` IN ('pending', 'approved', 'rejected')),
	CONSTRAINT `submissions_tags_json_check` CHECK(json_valid(`tags`) AND json_type(`tags`) = 'array'),
	CONSTRAINT `submissions_reviewed_check` CHECK((`status` = 'pending' AND `reviewed_at` IS NULL) OR (`status` <> 'pending' AND `reviewed_at` IS NOT NULL))
);--> statement-breakpoint
INSERT INTO `submissions_new`
SELECT `id`, `name`, `url`,
	lower(replace(CASE WHEN instr(substr(`url`, instr(`url`, '://') + 3), '/') > 0 THEN substr(`url`, instr(`url`, '://') + 3, instr(substr(`url`, instr(`url`, '://') + 3), '/') - 1) ELSE substr(`url`, instr(`url`, '://') + 3) END, 'www.', '')),
	`description`, CASE WHEN json_valid(`tags`) AND json_type(`tags`) = 'array' THEN `tags` ELSE '[]' END,
	`thumbnail_key`, `thumbnail_alt`,
	CASE WHEN `status` IN ('pending', 'approved', 'rejected') THEN `status` ELSE 'rejected' END,
	`submitted_at`, CASE WHEN `status` = 'pending' THEN NULL ELSE coalesce(`reviewed_at`, unixepoch()) END
FROM `submissions`;--> statement-breakpoint
DROP TABLE `submissions`;--> statement-breakpoint
ALTER TABLE `submissions_new` RENAME TO `submissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_open_url_unique` ON `submissions` (`url_key`) WHERE `status` IN ('pending', 'approved');--> statement-breakpoint
CREATE INDEX `submissions_status_date_idx` ON `submissions` (`status`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `sites_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`url_key` text NOT NULL,
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
	`submission_id` integer REFERENCES `submissions`(`id`) ON DELETE SET NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `sites_status_check` CHECK(`status` IN ('active', 'archived')),
	CONSTRAINT `sites_source_check` CHECK(`source` IN ('Directory', 'Submission', 'Manual')),
	CONSTRAINT `sites_submission_source_check` CHECK((`source` = 'Submission') = (`submission_id` IS NOT NULL)),
	CONSTRAINT `sites_visits_nonnegative_check` CHECK(`visits` >= 0),
	CONSTRAINT `sites_categories_json_check` CHECK(json_valid(`categories`) AND json_type(`categories`) = 'array'),
	CONSTRAINT `sites_notes_json_check` CHECK(json_valid(`notes`) AND json_type(`notes`) = 'array'),
	CONSTRAINT `sites_facts_json_check` CHECK(json_valid(`facts`) AND json_type(`facts`) = 'array')
);--> statement-breakpoint
INSERT INTO `sites_new`
SELECT `id`, `slug`, `name`, `url`,
	lower(replace(CASE WHEN instr(substr(`url`, instr(`url`, '://') + 3), '/') > 0 THEN substr(`url`, instr(`url`, '://') + 3, instr(substr(`url`, instr(`url`, '://') + 3), '/') - 1) ELSE substr(`url`, instr(`url`, '://') + 3) END, 'www.', '')),
	`description`, `summary`,
	CASE WHEN json_valid(`categories`) AND json_type(`categories`) = 'array' THEN `categories` ELSE '[]' END,
	`poster`, CASE WHEN json_valid(`notes`) AND json_type(`notes`) = 'array' THEN `notes` ELSE '[]' END,
	CASE WHEN json_valid(`facts`) AND json_type(`facts`) = 'array' THEN `facts` ELSE '[]' END,
	`accent`, `thumbnail_key`, `thumbnail_alt`, max(0, `visits`),
	CASE WHEN `source` = 'Submission' AND NOT EXISTS (SELECT 1 FROM `submissions` WHERE `submissions`.`id` = `sites`.`submission_id` AND `submissions`.`status` = 'approved') THEN 'archived' WHEN `status` IN ('active', 'archived') THEN `status` ELSE 'archived' END,
	CASE WHEN `source` = 'Submission' AND `submission_id` IS NOT NULL THEN 'Submission' WHEN `source` = 'Directory' THEN 'Directory' ELSE 'Manual' END,
	CASE WHEN `source` = 'Submission' THEN `submission_id` ELSE NULL END,
	`added_at`, `created_at` FROM `sites`;--> statement-breakpoint
DROP TABLE `sites`;--> statement-breakpoint
ALTER TABLE `sites_new` RENAME TO `sites`;--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_unique` ON `sites` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_unique` ON `sites` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_key_unique` ON `sites` (`url_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_submission_unique` ON `sites` (`submission_id`);--> statement-breakpoint
CREATE INDEX `sites_status_added_idx` ON `sites` (`status`,`added_at`);--> statement-breakpoint
CREATE TABLE `site_tags_new` (
	`site_id` integer NOT NULL REFERENCES `sites`(`id`) ON DELETE CASCADE,
	`tag_id` integer NOT NULL REFERENCES `tags`(`id`) ON DELETE CASCADE,
	`raw_name` text NOT NULL,
	PRIMARY KEY(`site_id`,`raw_name`)
);--> statement-breakpoint
INSERT INTO `site_tags_new` SELECT * FROM `site_tags` WHERE length(trim(`raw_name`)) > 0;--> statement-breakpoint
DROP TABLE `site_tags`;--> statement-breakpoint
ALTER TABLE `site_tags_new` RENAME TO `site_tags`;--> statement-breakpoint
CREATE INDEX `site_tags_tag_idx` ON `site_tags` (`tag_id`);--> statement-breakpoint
CREATE TRIGGER `sites_active_submission_insert_check`
BEFORE INSERT ON `sites` WHEN NEW.`source` = 'Submission' AND NEW.`status` = 'active'
AND NOT EXISTS (SELECT 1 FROM `submissions` WHERE `id` = NEW.`submission_id` AND `status` = 'approved')
BEGIN SELECT RAISE(ABORT, 'active submission site requires approved submission'); END;--> statement-breakpoint
CREATE TRIGGER `sites_active_submission_update_check`
BEFORE UPDATE OF `status`, `source`, `submission_id` ON `sites` WHEN NEW.`source` = 'Submission' AND NEW.`status` = 'active'
AND NOT EXISTS (SELECT 1 FROM `submissions` WHERE `id` = NEW.`submission_id` AND `status` = 'approved')
BEGIN SELECT RAISE(ABORT, 'active submission site requires approved submission'); END;--> statement-breakpoint
CREATE TRIGGER `submissions_status_site_check`
BEFORE UPDATE OF `status` ON `submissions` WHEN NEW.`status` <> 'approved'
AND EXISTS (SELECT 1 FROM `sites` WHERE `submission_id` = NEW.`id` AND `status` = 'active')
BEGIN SELECT RAISE(ABORT, 'archive submission site before changing approval'); END;--> statement-breakpoint
CREATE TRIGGER `submissions_existing_site_insert_check`
BEFORE INSERT ON `submissions` WHEN EXISTS (SELECT 1 FROM `sites` WHERE `url_key` = NEW.`url_key`)
BEGIN SELECT RAISE(ABORT, 'website already exists'); END;--> statement-breakpoint
CREATE TRIGGER `submissions_existing_site_update_check`
BEFORE UPDATE OF `url_key`, `status` ON `submissions` WHEN NEW.`status` IN ('pending', 'approved')
AND EXISTS (SELECT 1 FROM `sites` WHERE `url_key` = NEW.`url_key` AND (`submission_id` IS NULL OR `submission_id` <> NEW.`id`))
BEGIN SELECT RAISE(ABORT, 'website already exists'); END;--> statement-breakpoint
CREATE TRIGGER `sites_open_submission_insert_check`
BEFORE INSERT ON `sites` WHEN NEW.`source` <> 'Submission' AND EXISTS (SELECT 1 FROM `submissions` WHERE `url_key` = NEW.`url_key` AND `status` IN ('pending', 'approved'))
BEGIN SELECT RAISE(ABORT, 'website has an open submission'); END;--> statement-breakpoint
CREATE TRIGGER `sites_open_submission_update_check`
BEFORE UPDATE OF `url_key`, `source`, `submission_id` ON `sites` WHEN NEW.`source` <> 'Submission'
AND EXISTS (SELECT 1 FROM `submissions` WHERE `url_key` = NEW.`url_key` AND `status` IN ('pending', 'approved'))
BEGIN SELECT RAISE(ABORT, 'website has an open submission'); END;--> statement-breakpoint
CREATE TRIGGER `submissions_tags_values_insert_check` BEFORE INSERT ON `submissions`
WHEN EXISTS (SELECT 1 FROM json_each(NEW.`tags`) WHERE type <> 'text' OR length(trim(value)) = 0)
BEGIN SELECT RAISE(ABORT, 'invalid submission tags'); END;--> statement-breakpoint
CREATE TRIGGER `submissions_tags_values_update_check` BEFORE UPDATE OF `tags` ON `submissions`
WHEN EXISTS (SELECT 1 FROM json_each(NEW.`tags`) WHERE type <> 'text' OR length(trim(value)) = 0)
BEGIN SELECT RAISE(ABORT, 'invalid submission tags'); END;--> statement-breakpoint
CREATE TRIGGER `sites_json_values_insert_check` BEFORE INSERT ON `sites`
WHEN EXISTS (SELECT 1 FROM json_each(NEW.`categories`) WHERE type <> 'text')
OR EXISTS (SELECT 1 FROM json_each(NEW.`notes`) WHERE type <> 'text')
OR EXISTS (SELECT 1 FROM json_each(NEW.`facts`) WHERE type <> 'object' OR json_type(value, '$.label') <> 'text' OR json_type(value, '$.value') <> 'text')
BEGIN SELECT RAISE(ABORT, 'invalid site JSON values'); END;--> statement-breakpoint
CREATE TRIGGER `sites_json_values_update_check` BEFORE UPDATE OF `categories`, `notes`, `facts` ON `sites`
WHEN EXISTS (SELECT 1 FROM json_each(NEW.`categories`) WHERE type <> 'text')
OR EXISTS (SELECT 1 FROM json_each(NEW.`notes`) WHERE type <> 'text')
OR EXISTS (SELECT 1 FROM json_each(NEW.`facts`) WHERE type <> 'object' OR json_type(value, '$.label') <> 'text' OR json_type(value, '$.value') <> 'text')
BEGIN SELECT RAISE(ABORT, 'invalid site JSON values'); END;--> statement-breakpoint
CREATE TRIGGER `tag_parents_cycle_insert_check`
BEFORE INSERT ON `tag_parents`
BEGIN
	SELECT CASE WHEN NEW.`parent_tag_id` = NEW.`child_tag_id` THEN RAISE(ABORT, 'tag parent cycle') END;
	WITH RECURSIVE descendants(`id`) AS (
		SELECT NEW.`child_tag_id` UNION SELECT `child_tag_id` FROM `tag_parents` JOIN descendants ON `parent_tag_id` = descendants.`id`
	) SELECT CASE WHEN EXISTS (SELECT 1 FROM descendants WHERE `id` = NEW.`parent_tag_id`) THEN RAISE(ABORT, 'tag parent cycle') END;
END;--> statement-breakpoint
CREATE TRIGGER `tag_parents_cycle_update_check`
BEFORE UPDATE OF `parent_tag_id`, `child_tag_id` ON `tag_parents`
BEGIN
	SELECT CASE WHEN NEW.`parent_tag_id` = NEW.`child_tag_id` THEN RAISE(ABORT, 'tag parent cycle') END;
	WITH RECURSIVE descendants(`id`) AS (
		SELECT NEW.`child_tag_id` UNION SELECT `child_tag_id` FROM `tag_parents` JOIN descendants ON `parent_tag_id` = descendants.`id` WHERE NOT (`parent_tag_id` = OLD.`parent_tag_id` AND `child_tag_id` = OLD.`child_tag_id`)
	) SELECT CASE WHEN EXISTS (SELECT 1 FROM descendants WHERE `id` = NEW.`parent_tag_id`) THEN RAISE(ABORT, 'tag parent cycle') END;
END;--> statement-breakpoint
DELETE FROM `admin_sessions` WHERE `revoked_at` IS NULL AND `id` NOT IN (SELECT `id` FROM `admin_sessions` current WHERE current.`revoked_at` IS NULL AND current.`username` = `admin_sessions`.`username` ORDER BY current.`created_at` DESC LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_one_live_username_unique` ON `admin_sessions` (`username`) WHERE `revoked_at` IS NULL;--> statement-breakpoint
DELETE FROM `tags` WHERE length(trim(`slug`)) = 0;--> statement-breakpoint
CREATE TRIGGER `tags_slug_insert_check` BEFORE INSERT ON `tags` WHEN length(trim(NEW.`slug`)) = 0 OR NEW.`canonical` NOT IN (0, 1) BEGIN SELECT RAISE(ABORT, 'invalid tag'); END;--> statement-breakpoint
CREATE TRIGGER `tags_slug_update_check` BEFORE UPDATE OF `slug`, `canonical` ON `tags` WHEN length(trim(NEW.`slug`)) = 0 OR NEW.`canonical` NOT IN (0, 1) BEGIN SELECT RAISE(ABORT, 'invalid tag'); END;--> statement-breakpoint
CREATE TRIGGER `admin_sessions_expiry_insert_check` BEFORE INSERT ON `admin_sessions` WHEN NEW.`expires_at` <= NEW.`created_at` BEGIN SELECT RAISE(ABORT, 'session expiry must follow creation'); END;--> statement-breakpoint
CREATE TRIGGER `admin_sessions_expiry_update_check` BEFORE UPDATE OF `created_at`, `expires_at` ON `admin_sessions` WHEN NEW.`expires_at` <= NEW.`created_at` BEGIN SELECT RAISE(ABORT, 'session expiry must follow creation'); END;--> statement-breakpoint
CREATE TRIGGER `admin_login_failures_nonnegative_insert_check` BEFORE INSERT ON `admin_login_attempts` WHEN NEW.`failures` < 0 BEGIN SELECT RAISE(ABORT, 'login failures must be nonnegative'); END;--> statement-breakpoint
CREATE TRIGGER `admin_login_failures_nonnegative_update_check` BEFORE UPDATE OF `failures` ON `admin_login_attempts` WHEN NEW.`failures` < 0 BEGIN SELECT RAISE(ABORT, 'login failures must be nonnegative'); END;--> statement-breakpoint
CREATE TRIGGER `public_rate_limit_nonnegative_insert_check` BEFORE INSERT ON `public_rate_limits` WHEN NEW.`count` < 0 BEGIN SELECT RAISE(ABORT, 'rate limit count must be nonnegative'); END;--> statement-breakpoint
CREATE TRIGGER `public_rate_limit_nonnegative_update_check` BEFORE UPDATE OF `count` ON `public_rate_limits` WHEN NEW.`count` < 0 BEGIN SELECT RAISE(ABORT, 'rate limit count must be nonnegative'); END;--> statement-breakpoint
CREATE TABLE `_foreign_key_guard` (`violations` integer CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `_foreign_key_guard` SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `_foreign_key_guard`;
