CREATE TABLE `public_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_started` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `submissions_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_open_url_unique` ON `submissions` (`url`) WHERE "submissions"."status" IN ('pending', 'approved');--> statement-breakpoint
ALTER TABLE `sites` ADD `submission_id` integer REFERENCES submissions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sites_submission_unique` ON `sites` (`submission_id`);--> statement-breakpoint
UPDATE `sites`
SET `submission_id` = (
	SELECT `submissions`.`id`
	FROM `submissions`
	WHERE `submissions`.`url` = `sites`.`url`
	LIMIT 1
)
WHERE `sites`.`source` = 'Submission'
	AND `sites`.`submission_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `submissions` WHERE `submissions`.`url` = `sites`.`url`
	);--> statement-breakpoint
UPDATE `sites`
SET `status` = 'archived'
WHERE `source` = 'Submission'
	AND (
		`submission_id` IS NULL OR
		NOT EXISTS (
			SELECT 1 FROM `submissions`
			WHERE `submissions`.`id` = `sites`.`submission_id`
				AND `submissions`.`status` = 'approved'
		)
	);--> statement-breakpoint
DELETE FROM `guestbook`
WHERE (`name`, `message`, `created_at`) IN (
	('moss_rat', 'found the rain mixer; staying awhile', unixepoch('2026-08-07T12:00:00Z')),
	('cablecoma', 'radio set to somewhere very far away', unixepoch('2026-08-06T12:00:00Z')),
	('lumi.void', 'the cursor site got me again', unixepoch('2026-08-04T12:00:00Z')),
	('dialtone_x', 'excellent detour, no notes', unixepoch('2026-08-02T12:00:00Z'))
);--> statement-breakpoint
DELETE FROM `sites`
WHERE `source` = 'Submission' AND `submission_id` IN (
	SELECT `id` FROM `submissions`
	WHERE `thumbnail_key` IS NULL AND (
		(`name` = 'The Museum of Anything' AND `url` = 'https://museumofanything.com/' AND `description` = 'A strange museum full of things that don''t fit together.' AND `submitted_at` = unixepoch('2026-08-06T10:00:00Z')) OR
		(`name` = 'Neonflames' AND `url` = 'https://www.neonflames.com/' AND `description` = 'Paint with glowing colors on a black canvas.' AND `submitted_at` = unixepoch('2026-08-04T10:00:00Z')) OR
		(`name` = 'Windows 93' AND `url` = 'https://www.windows93.net/' AND `description` = 'A ridiculous fake operating system.' AND `submitted_at` = unixepoch('2026-08-02T10:00:00Z'))
	)
);--> statement-breakpoint
DELETE FROM `submissions`
WHERE `thumbnail_key` IS NULL AND (
	(`name` = 'The Museum of Anything' AND `url` = 'https://museumofanything.com/' AND `description` = 'A strange museum full of things that don''t fit together.' AND `submitted_at` = unixepoch('2026-08-06T10:00:00Z')) OR
	(`name` = 'Neonflames' AND `url` = 'https://www.neonflames.com/' AND `description` = 'Paint with glowing colors on a black canvas.' AND `submitted_at` = unixepoch('2026-08-04T10:00:00Z')) OR
	(`name` = 'Windows 93' AND `url` = 'https://www.windows93.net/' AND `description` = 'A ridiculous fake operating system.' AND `submitted_at` = unixepoch('2026-08-02T10:00:00Z'))
);
