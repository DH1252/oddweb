-- release: maintenance-required
CREATE TABLE `tag_assignment_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` integer NOT NULL,
	`tag_id` integer,
	`replacement_tag_id` integer,
	`job_id` text,
	`candidate_id` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`source` text NOT NULL,
	`confidence_micros` integer,
	`was_assigned` integer NOT NULL,
	`is_assigned` integer NOT NULL,
	`reason` text NOT NULL,
	`input_hash` text NOT NULL,
	`taxonomy_version` integer NOT NULL,
	`site_content_version` integer NOT NULL,
	`provider_config_id` integer,
	`policy_config_id` integer,
	`supersedes_decision_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`replacement_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`candidate_id`) REFERENCES `taxonomy_candidates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_config_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_decision_id`) REFERENCES `tag_assignment_decisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tag_assignment_decisions_action_check" CHECK("tag_assignment_decisions"."action" IN ('add', 'remove', 'retain', 'replace') AND (("tag_assignment_decisions"."action" = 'replace' AND "tag_assignment_decisions"."tag_id" IS NOT NULL AND "tag_assignment_decisions"."replacement_tag_id" IS NOT NULL AND "tag_assignment_decisions"."tag_id" <> "tag_assignment_decisions"."replacement_tag_id") OR ("tag_assignment_decisions"."action" <> 'replace' AND "tag_assignment_decisions"."tag_id" IS NOT NULL AND "tag_assignment_decisions"."replacement_tag_id" IS NULL))),
	CONSTRAINT "tag_assignment_decisions_outcome_check" CHECK("tag_assignment_decisions"."outcome" IN ('applied', 'rejected', 'shadow', 'locked', 'obsolete', 'conservative')),
	CONSTRAINT "tag_assignment_decisions_source_check" CHECK("tag_assignment_decisions"."source" IN ('deterministic', 'provider', 'admin', 'migration')),
	CONSTRAINT "tag_assignment_decisions_score_check" CHECK("tag_assignment_decisions"."confidence_micros" IS NULL OR "tag_assignment_decisions"."confidence_micros" BETWEEN 0 AND 1000000),
	CONSTRAINT "tag_assignment_decisions_assignment_check" CHECK("tag_assignment_decisions"."was_assigned" IN (0, 1) AND "tag_assignment_decisions"."is_assigned" IN (0, 1)),
	CONSTRAINT "tag_assignment_decisions_hash_version_check" CHECK(length("tag_assignment_decisions"."input_hash") = 64 AND "tag_assignment_decisions"."taxonomy_version" >= 1 AND "tag_assignment_decisions"."site_content_version" >= 1),
	CONSTRAINT "tag_assignment_decisions_supersedes_check" CHECK("tag_assignment_decisions"."supersedes_decision_id" IS NULL OR "tag_assignment_decisions"."supersedes_decision_id" <> "tag_assignment_decisions"."id")
);
--> statement-breakpoint
CREATE INDEX `tag_assignment_decisions_site_idx` ON `tag_assignment_decisions` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tag_assignment_decisions_effective_idx` ON `tag_assignment_decisions` (`site_id`,`tag_id`,`outcome`,`created_at`);--> statement-breakpoint
CREATE INDEX `tag_assignment_decisions_job_idx` ON `tag_assignment_decisions` (`job_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`job_id` text,
	`decision_id` text,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`provider_config_id` integer,
	`provider_model` text,
	`policy_config_id` integer,
	`prompt_hash` text,
	`schema_hash` text,
	`input_hash` text,
	`taxonomy_version_before` integer NOT NULL,
	`taxonomy_version_after` integer NOT NULL,
	`scores` text DEFAULT '{}' NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`release_sha` text NOT NULL,
	`rollback_of_event_id` text,
	`compensates_event_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `taxonomy_change_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decision_id`) REFERENCES `tag_assignment_decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_config_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rollback_of_event_id`) REFERENCES `taxonomy_audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensates_event_id`) REFERENCES `taxonomy_audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_audit_events_actor_check" CHECK("taxonomy_audit_events"."actor_type" IN ('system', 'provider', 'admin', 'migration')),
	CONSTRAINT "taxonomy_audit_events_versions_check" CHECK("taxonomy_audit_events"."taxonomy_version_before" >= 1 AND "taxonomy_audit_events"."taxonomy_version_after" >= 1),
	CONSTRAINT "taxonomy_audit_events_hashes_check" CHECK(("taxonomy_audit_events"."prompt_hash" IS NULL OR length("taxonomy_audit_events"."prompt_hash") = 64) AND ("taxonomy_audit_events"."schema_hash" IS NULL OR length("taxonomy_audit_events"."schema_hash") = 64) AND ("taxonomy_audit_events"."input_hash" IS NULL OR length("taxonomy_audit_events"."input_hash") = 64)),
	CONSTRAINT "taxonomy_audit_events_json_check" CHECK(json_valid("taxonomy_audit_events"."scores") AND json_type("taxonomy_audit_events"."scores") = 'object' AND json_valid("taxonomy_audit_events"."before") AND json_valid("taxonomy_audit_events"."after")),
	CONSTRAINT "taxonomy_audit_events_links_check" CHECK(("taxonomy_audit_events"."rollback_of_event_id" IS NULL OR "taxonomy_audit_events"."rollback_of_event_id" <> "taxonomy_audit_events"."id") AND ("taxonomy_audit_events"."compensates_event_id" IS NULL OR "taxonomy_audit_events"."compensates_event_id" <> "taxonomy_audit_events"."id"))
);
--> statement-breakpoint
CREATE INDEX `taxonomy_audit_events_batch_idx` ON `taxonomy_audit_events` (`batch_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_audit_events_entity_idx` ON `taxonomy_audit_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_audit_events_job_idx` ON `taxonomy_audit_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_audit_events_rollback_idx` ON `taxonomy_audit_events` (`rollback_of_event_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_id` text,
	`candidate_key` text NOT NULL,
	`kind` text NOT NULL,
	`tag_id` integer,
	`related_tag_id` integer,
	`normalized_concept` text,
	`proposed_name` text,
	`proposed_slug` text,
	`payload` text NOT NULL,
	`confidence_micros` integer NOT NULL,
	`margin_micros` integer,
	`rank` integer NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`decision_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `taxonomy_job_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`related_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_candidates_kind_check" CHECK("taxonomy_candidates"."kind" IN ('existing_tag', 'novel_concept', 'alias', 'merge', 'parent_edge')),
	CONSTRAINT "taxonomy_candidates_target_check" CHECK(("taxonomy_candidates"."kind" = 'existing_tag' AND "taxonomy_candidates"."tag_id" IS NOT NULL) OR ("taxonomy_candidates"."kind" = 'novel_concept' AND "taxonomy_candidates"."normalized_concept" IS NOT NULL AND "taxonomy_candidates"."proposed_name" IS NOT NULL AND "taxonomy_candidates"."proposed_slug" IS NOT NULL) OR ("taxonomy_candidates"."kind" = 'alias' AND "taxonomy_candidates"."tag_id" IS NOT NULL AND "taxonomy_candidates"."normalized_concept" IS NOT NULL) OR ("taxonomy_candidates"."kind" IN ('merge', 'parent_edge') AND "taxonomy_candidates"."tag_id" IS NOT NULL AND "taxonomy_candidates"."related_tag_id" IS NOT NULL AND "taxonomy_candidates"."tag_id" <> "taxonomy_candidates"."related_tag_id")),
	CONSTRAINT "taxonomy_candidates_payload_check" CHECK(json_valid("taxonomy_candidates"."payload") AND json_type("taxonomy_candidates"."payload") = 'object'),
	CONSTRAINT "taxonomy_candidates_score_check" CHECK("taxonomy_candidates"."confidence_micros" BETWEEN 0 AND 1000000 AND ("taxonomy_candidates"."margin_micros" IS NULL OR "taxonomy_candidates"."margin_micros" BETWEEN 0 AND 1000000) AND "taxonomy_candidates"."rank" >= 0),
	CONSTRAINT "taxonomy_candidates_status_check" CHECK("taxonomy_candidates"."status" IN ('proposed', 'accepted', 'rejected', 'deferred', 'conflict') AND (("taxonomy_candidates"."status" = 'proposed' AND "taxonomy_candidates"."decided_at" IS NULL) OR ("taxonomy_candidates"."status" <> 'proposed' AND "taxonomy_candidates"."decided_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_candidates_job_key_unique` ON `taxonomy_candidates` (`job_id`,`candidate_key`);--> statement-breakpoint
CREATE INDEX `taxonomy_candidates_concept_idx` ON `taxonomy_candidates` (`normalized_concept`,`status`);--> statement-breakpoint
CREATE INDEX `taxonomy_candidates_tag_idx` ON `taxonomy_candidates` (`tag_id`,`status`);--> statement-breakpoint
CREATE TABLE `taxonomy_change_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`expected_taxonomy_version` integer NOT NULL,
	`resulting_taxonomy_version` integer,
	`parent_batch_id` text,
	`rollback_of_batch_id` text,
	`summary` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`applied_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`parent_batch_id`) REFERENCES `taxonomy_change_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rollback_of_batch_id`) REFERENCES `taxonomy_change_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_change_batches_id_check" CHECK(length(trim("taxonomy_change_batches"."id")) > 0),
	CONSTRAINT "taxonomy_change_batches_kind_check" CHECK("taxonomy_change_batches"."kind" IN ('migration', 'classification', 'ontology', 'rollback')),
	CONSTRAINT "taxonomy_change_batches_status_check" CHECK("taxonomy_change_batches"."status" IN ('planned', 'applying', 'applied', 'failed', 'rolling_back', 'rolled_back', 'partial')),
	CONSTRAINT "taxonomy_change_batches_actor_check" CHECK("taxonomy_change_batches"."actor_type" IN ('system', 'admin', 'migration')),
	CONSTRAINT "taxonomy_change_batches_versions_check" CHECK("taxonomy_change_batches"."expected_taxonomy_version" >= 1 AND ("taxonomy_change_batches"."resulting_taxonomy_version" IS NULL OR "taxonomy_change_batches"."resulting_taxonomy_version" >= "taxonomy_change_batches"."expected_taxonomy_version")),
	CONSTRAINT "taxonomy_change_batches_links_check" CHECK(("taxonomy_change_batches"."parent_batch_id" IS NULL OR "taxonomy_change_batches"."parent_batch_id" <> "taxonomy_change_batches"."id") AND ("taxonomy_change_batches"."rollback_of_batch_id" IS NULL OR "taxonomy_change_batches"."rollback_of_batch_id" <> "taxonomy_change_batches"."id"))
);
--> statement-breakpoint
CREATE INDEX `taxonomy_change_batches_status_idx` ON `taxonomy_change_batches` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_change_batches_rollback_idx` ON `taxonomy_change_batches` (`rollback_of_batch_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_concept_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_concept` text NOT NULL,
	`site_id` integer NOT NULL,
	`input_hash` text NOT NULL,
	`source_key` text NOT NULL,
	`source` text NOT NULL,
	`provider_config_id` integer,
	`policy_config_id` integer,
	`job_id` text,
	`attempt_id` text,
	`evidence_hash` text NOT NULL,
	`evidence_snippet` text NOT NULL,
	`confidence_micros` integer NOT NULL,
	`accepted` integer DEFAULT false NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_config_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attempt_id`) REFERENCES `taxonomy_job_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "taxonomy_concept_evidence_concept_check" CHECK(length(trim("taxonomy_concept_evidence"."normalized_concept")) > 0),
	CONSTRAINT "taxonomy_concept_evidence_source_check" CHECK("taxonomy_concept_evidence"."source" IN ('submitted_hint', 'deterministic', 'provider') AND (("taxonomy_concept_evidence"."source" = 'provider' AND "taxonomy_concept_evidence"."provider_config_id" IS NOT NULL) OR ("taxonomy_concept_evidence"."source" <> 'provider' AND "taxonomy_concept_evidence"."provider_config_id" IS NULL))),
	CONSTRAINT "taxonomy_concept_evidence_hash_check" CHECK(length("taxonomy_concept_evidence"."input_hash") = 64 AND length("taxonomy_concept_evidence"."evidence_hash") = 64),
	CONSTRAINT "taxonomy_concept_evidence_score_check" CHECK("taxonomy_concept_evidence"."confidence_micros" BETWEEN 0 AND 1000000 AND "taxonomy_concept_evidence"."accepted" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_concept_evidence_distinct_unique` ON `taxonomy_concept_evidence` (`normalized_concept`,`site_id`,`input_hash`,`source_key`);--> statement-breakpoint
CREATE INDEX `taxonomy_concept_evidence_lookup_idx` ON `taxonomy_concept_evidence` (`normalized_concept`,`accepted`,`observed_at`,`site_id`);--> statement-breakpoint
CREATE INDEX `taxonomy_concept_evidence_config_idx` ON `taxonomy_concept_evidence` (`provider_config_id`,`policy_config_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`provider_config_id` integer NOT NULL,
	`status` text NOT NULL,
	`provider_request_id` text,
	`provider_model` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_hash` text,
	`raw_response` text,
	`raw_response_expires_at` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer,
	`error_code` text,
	`error_summary` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_job_attempts_number_check" CHECK("taxonomy_job_attempts"."attempt_number" >= 1),
	CONSTRAINT "taxonomy_job_attempts_status_check" CHECK("taxonomy_job_attempts"."status" IN ('started', 'succeeded', 'retryable_failure', 'permanent_failure', 'invalid_response', 'cancelled')),
	CONSTRAINT "taxonomy_job_attempts_hash_check" CHECK(length("taxonomy_job_attempts"."request_hash") = 64 AND ("taxonomy_job_attempts"."response_hash" IS NULL OR length("taxonomy_job_attempts"."response_hash") = 64)),
	CONSTRAINT "taxonomy_job_attempts_usage_check" CHECK(("taxonomy_job_attempts"."input_tokens" IS NULL OR "taxonomy_job_attempts"."input_tokens" >= 0) AND ("taxonomy_job_attempts"."output_tokens" IS NULL OR "taxonomy_job_attempts"."output_tokens" >= 0) AND ("taxonomy_job_attempts"."latency_ms" IS NULL OR "taxonomy_job_attempts"."latency_ms" >= 0)),
	CONSTRAINT "taxonomy_job_attempts_completion_check" CHECK(("taxonomy_job_attempts"."status" = 'started') = ("taxonomy_job_attempts"."completed_at" IS NULL)),
	CONSTRAINT "taxonomy_job_attempts_raw_retention_check" CHECK(("taxonomy_job_attempts"."raw_response" IS NULL AND "taxonomy_job_attempts"."raw_response_expires_at" IS NULL) OR ("taxonomy_job_attempts"."raw_response" IS NOT NULL AND "taxonomy_job_attempts"."raw_response_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_job_attempts_job_number_unique` ON `taxonomy_job_attempts` (`job_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `taxonomy_job_attempts_provider_idx` ON `taxonomy_job_attempts` (`provider_config_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_job_attempts_raw_expiry_idx` ON `taxonomy_job_attempts` (`raw_response_expires_at`) WHERE "taxonomy_job_attempts"."raw_response" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `taxonomy_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_key` text NOT NULL,
	`kind` text NOT NULL,
	`site_id` integer,
	`concept_key` text,
	`input_hash` text NOT NULL,
	`site_content_version` integer,
	`taxonomy_version` integer NOT NULL,
	`provider_config_id` integer,
	`policy_config_id` integer,
	`batch_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`leased_until` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`last_error_code` text,
	`last_error_summary` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_config_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batch_id`) REFERENCES `taxonomy_change_batches`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "taxonomy_jobs_id_check" CHECK(length(trim("taxonomy_jobs"."id")) > 0),
	CONSTRAINT "taxonomy_jobs_kind_check" CHECK("taxonomy_jobs"."kind" IN ('classify_site', 'reassess_concept', 'apply_ontology', 'rollback')),
	CONSTRAINT "taxonomy_jobs_target_check" CHECK(("taxonomy_jobs"."kind" = 'classify_site' AND "taxonomy_jobs"."site_id" IS NOT NULL AND "taxonomy_jobs"."site_content_version" >= 1) OR ("taxonomy_jobs"."kind" = 'reassess_concept' AND "taxonomy_jobs"."concept_key" IS NOT NULL) OR ("taxonomy_jobs"."kind" IN ('apply_ontology', 'rollback'))),
	CONSTRAINT "taxonomy_jobs_hash_check" CHECK(length("taxonomy_jobs"."input_hash") = 64),
	CONSTRAINT "taxonomy_jobs_status_check" CHECK("taxonomy_jobs"."status" IN ('pending', 'leased', 'retry_wait', 'succeeded', 'settled', 'obsolete', 'dead', 'cancelled', 'degraded')),
	CONSTRAINT "taxonomy_jobs_attempts_check" CHECK("taxonomy_jobs"."attempt_count" >= 0 AND "taxonomy_jobs"."max_attempts" >= 1 AND "taxonomy_jobs"."attempt_count" <= "taxonomy_jobs"."max_attempts"),
	CONSTRAINT "taxonomy_jobs_lease_check" CHECK(("taxonomy_jobs"."status" = 'leased' AND "taxonomy_jobs"."lease_owner" IS NOT NULL AND "taxonomy_jobs"."lease_token" IS NOT NULL AND "taxonomy_jobs"."leased_until" IS NOT NULL) OR ("taxonomy_jobs"."status" <> 'leased' AND "taxonomy_jobs"."lease_owner" IS NULL AND "taxonomy_jobs"."lease_token" IS NULL AND "taxonomy_jobs"."leased_until" IS NULL)),
	CONSTRAINT "taxonomy_jobs_terminal_check" CHECK(("taxonomy_jobs"."status" IN ('succeeded', 'settled', 'obsolete', 'dead', 'cancelled', 'degraded')) = ("taxonomy_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_jobs_job_key_unique` ON `taxonomy_jobs` (`job_key`);--> statement-breakpoint
CREATE INDEX `taxonomy_jobs_pending_idx` ON `taxonomy_jobs` (`status`,`available_at`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `taxonomy_jobs_lease_idx` ON `taxonomy_jobs` (`leased_until`) WHERE "taxonomy_jobs"."status" = 'leased';--> statement-breakpoint
CREATE INDEX `taxonomy_jobs_retry_idx` ON `taxonomy_jobs` (`available_at`) WHERE "taxonomy_jobs"."status" = 'retry_wait';--> statement-breakpoint
CREATE INDEX `taxonomy_jobs_site_config_hash_idx` ON `taxonomy_jobs` (`site_id`,`input_hash`,`taxonomy_version`,`policy_config_id`,`provider_config_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`resource_key` text NOT NULL,
	`site_id` integer,
	`tag_id` integer,
	`related_tag_id` integer,
	`alias` text,
	`reason` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`released_by` text,
	`released_at` integer,
	`release_reason` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "taxonomy_locks_scope_check" CHECK("taxonomy_locks"."scope" IN ('site_assignment', 'tag', 'alias', 'merge', 'parent_edge')),
	CONSTRAINT "taxonomy_locks_target_check" CHECK(("taxonomy_locks"."scope" = 'site_assignment' AND "taxonomy_locks"."site_id" IS NOT NULL AND "taxonomy_locks"."tag_id" IS NOT NULL AND "taxonomy_locks"."related_tag_id" IS NULL AND "taxonomy_locks"."alias" IS NULL) OR ("taxonomy_locks"."scope" = 'tag' AND "taxonomy_locks"."site_id" IS NULL AND "taxonomy_locks"."tag_id" IS NOT NULL AND "taxonomy_locks"."related_tag_id" IS NULL AND "taxonomy_locks"."alias" IS NULL) OR ("taxonomy_locks"."scope" = 'alias' AND "taxonomy_locks"."site_id" IS NULL AND "taxonomy_locks"."tag_id" IS NOT NULL AND "taxonomy_locks"."related_tag_id" IS NULL AND "taxonomy_locks"."alias" IS NOT NULL) OR ("taxonomy_locks"."scope" IN ('merge', 'parent_edge') AND "taxonomy_locks"."site_id" IS NULL AND "taxonomy_locks"."tag_id" IS NOT NULL AND "taxonomy_locks"."related_tag_id" IS NOT NULL AND "taxonomy_locks"."tag_id" <> "taxonomy_locks"."related_tag_id" AND "taxonomy_locks"."alias" IS NULL)),
	CONSTRAINT "taxonomy_locks_revision_check" CHECK("taxonomy_locks"."revision" >= 1),
	CONSTRAINT "taxonomy_locks_release_check" CHECK(("taxonomy_locks"."released_at" IS NULL AND "taxonomy_locks"."released_by" IS NULL AND "taxonomy_locks"."release_reason" IS NULL) OR ("taxonomy_locks"."released_at" IS NOT NULL AND "taxonomy_locks"."released_by" IS NOT NULL AND "taxonomy_locks"."release_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_locks_active_resource_unique` ON `taxonomy_locks` (`resource_key`) WHERE "taxonomy_locks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX `taxonomy_locks_site_idx` ON `taxonomy_locks` (`site_id`,`released_at`);--> statement-breakpoint
CREATE INDEX `taxonomy_locks_tag_idx` ON `taxonomy_locks` (`tag_id`,`released_at`);--> statement-breakpoint
CREATE TABLE `taxonomy_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`topic` text DEFAULT 'taxonomy_jobs' NOT NULL,
	`payload` text NOT NULL,
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`lease_token` text,
	`leased_until` integer,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`dispatched_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `taxonomy_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "taxonomy_outbox_payload_check" CHECK(json_valid("taxonomy_outbox"."payload") AND json_type("taxonomy_outbox"."payload") = 'object' AND json_type("taxonomy_outbox"."payload", '$.jobId') = 'text'),
	CONSTRAINT "taxonomy_outbox_attempts_check" CHECK("taxonomy_outbox"."dispatch_attempts" >= 0),
	CONSTRAINT "taxonomy_outbox_lease_check" CHECK(("taxonomy_outbox"."lease_token" IS NULL) = ("taxonomy_outbox"."leased_until" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_outbox_job_unique` ON `taxonomy_outbox` (`job_id`);--> statement-breakpoint
CREATE INDEX `taxonomy_outbox_undispatched_idx` ON `taxonomy_outbox` (`available_at`,`id`) WHERE "taxonomy_outbox"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX `taxonomy_outbox_lease_idx` ON `taxonomy_outbox` (`leased_until`) WHERE "taxonomy_outbox"."dispatched_at" IS NULL AND "taxonomy_outbox"."leased_until" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `taxonomy_policy_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer NOT NULL,
	`assignment_limit` integer NOT NULL,
	`novel_evidence_site_threshold` integer NOT NULL,
	`assignment_confidence_micros` integer NOT NULL,
	`ontology_confidence_micros` integer NOT NULL,
	`minimum_margin_micros` integer NOT NULL,
	`hierarchy_max_depth` integer NOT NULL,
	`hierarchy_max_fanout` integer NOT NULL,
	`ontology_provider_agreement` integer NOT NULL,
	`retry_budget` integer NOT NULL,
	`retry_base_seconds` integer NOT NULL,
	`retry_max_seconds` integer NOT NULL,
	`rollout_basis_points` integer NOT NULL,
	`daily_request_budget` integer NOT NULL,
	`daily_token_budget` integer NOT NULL,
	`schema_failure_trip_basis_points` integer NOT NULL,
	`disagreement_trip_basis_points` integer NOT NULL,
	`rollback_trip_basis_points` integer NOT NULL,
	`mutation_volume_trip_count` integer NOT NULL,
	`raw_response_retention_seconds` integer NOT NULL,
	`shadow_minimum_samples` integer NOT NULL,
	`shadow_minimum_coverage_basis_points` integer NOT NULL,
	`shadow_schema_success_basis_points` integer NOT NULL,
	`shadow_provider_agreement_basis_points` integer NOT NULL,
	`prompt_hash` text NOT NULL,
	`schema_hash` text NOT NULL,
	`supersedes_id` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`supersedes_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_policy_configs_positive_limits_check" CHECK("taxonomy_policy_configs"."revision" >= 1 AND "taxonomy_policy_configs"."assignment_limit" BETWEEN 1 AND 100 AND "taxonomy_policy_configs"."novel_evidence_site_threshold" >= 1 AND "taxonomy_policy_configs"."hierarchy_max_depth" BETWEEN 1 AND 32 AND "taxonomy_policy_configs"."hierarchy_max_fanout" BETWEEN 1 AND 1000 AND "taxonomy_policy_configs"."ontology_provider_agreement" >= 1 AND "taxonomy_policy_configs"."retry_budget" BETWEEN 0 AND 100),
	CONSTRAINT "taxonomy_policy_configs_confidence_check" CHECK("taxonomy_policy_configs"."assignment_confidence_micros" BETWEEN 0 AND 1000000 AND "taxonomy_policy_configs"."ontology_confidence_micros" BETWEEN 0 AND 1000000 AND "taxonomy_policy_configs"."minimum_margin_micros" BETWEEN 0 AND 1000000),
	CONSTRAINT "taxonomy_policy_configs_retry_check" CHECK("taxonomy_policy_configs"."retry_base_seconds" >= 1 AND "taxonomy_policy_configs"."retry_max_seconds" >= "taxonomy_policy_configs"."retry_base_seconds"),
	CONSTRAINT "taxonomy_policy_configs_budgets_check" CHECK("taxonomy_policy_configs"."daily_request_budget" >= 0 AND "taxonomy_policy_configs"."daily_token_budget" >= 0 AND "taxonomy_policy_configs"."mutation_volume_trip_count" >= 0 AND "taxonomy_policy_configs"."raw_response_retention_seconds" >= 0 AND "taxonomy_policy_configs"."shadow_minimum_samples" >= 0),
	CONSTRAINT "taxonomy_policy_configs_basis_points_check" CHECK("taxonomy_policy_configs"."rollout_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."schema_failure_trip_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."disagreement_trip_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."rollback_trip_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."shadow_minimum_coverage_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."shadow_schema_success_basis_points" BETWEEN 0 AND 10000 AND "taxonomy_policy_configs"."shadow_provider_agreement_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "taxonomy_policy_configs_hashes_check" CHECK(length("taxonomy_policy_configs"."prompt_hash") = 64 AND length("taxonomy_policy_configs"."schema_hash") = 64),
	CONSTRAINT "taxonomy_policy_configs_supersedes_check" CHECK("taxonomy_policy_configs"."supersedes_id" IS NULL OR "taxonomy_policy_configs"."supersedes_id" <> "taxonomy_policy_configs"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_policy_configs_revision_unique` ON `taxonomy_policy_configs` (`revision`);--> statement-breakpoint
CREATE TABLE `taxonomy_provider_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`provider_kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`dialect` text,
	`routing_group` text DEFAULT 'default' NOT NULL,
	`routing_role` text DEFAULT 'primary' NOT NULL,
	`routing_priority` integer DEFAULT 0 NOT NULL,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`key_version` integer NOT NULL,
	`credential_nonce` text NOT NULL,
	`credential_ciphertext` text NOT NULL,
	`credential_fingerprint` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`supersedes_id` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`supersedes_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_provider_configs_name_check" CHECK(length(trim("taxonomy_provider_configs"."name")) > 0 AND length(trim("taxonomy_provider_configs"."routing_group")) > 0),
	CONSTRAINT "taxonomy_provider_configs_revision_check" CHECK("taxonomy_provider_configs"."revision" >= 1),
	CONSTRAINT "taxonomy_provider_configs_kind_check" CHECK("taxonomy_provider_configs"."provider_kind" IN ('openai_compatible', 'gemini')),
	CONSTRAINT "taxonomy_provider_configs_endpoint_check" CHECK(lower("taxonomy_provider_configs"."endpoint") LIKE 'https://%' AND instr(substr("taxonomy_provider_configs"."endpoint", 9), '@') = 0),
	CONSTRAINT "taxonomy_provider_configs_dialect_check" CHECK(("taxonomy_provider_configs"."provider_kind" = 'openai_compatible' AND "taxonomy_provider_configs"."dialect" IN ('responses', 'chat_completions')) OR ("taxonomy_provider_configs"."provider_kind" = 'gemini' AND "taxonomy_provider_configs"."dialect" IS NULL)),
	CONSTRAINT "taxonomy_provider_configs_routing_role_check" CHECK("taxonomy_provider_configs"."routing_role" IN ('primary', 'failover', 'consensus')),
	CONSTRAINT "taxonomy_provider_configs_priority_check" CHECK("taxonomy_provider_configs"."routing_priority" >= 0),
	CONSTRAINT "taxonomy_provider_configs_timeout_check" CHECK("taxonomy_provider_configs"."timeout_ms" BETWEEN 1000 AND 120000),
	CONSTRAINT "taxonomy_provider_configs_encryption_check" CHECK("taxonomy_provider_configs"."key_version" >= 1 AND length("taxonomy_provider_configs"."credential_nonce") >= 16 AND length("taxonomy_provider_configs"."credential_ciphertext") >= 16 AND length("taxonomy_provider_configs"."credential_fingerprint") >= 8),
	CONSTRAINT "taxonomy_provider_configs_enabled_check" CHECK("taxonomy_provider_configs"."enabled" IN (0, 1)),
	CONSTRAINT "taxonomy_provider_configs_supersedes_check" CHECK("taxonomy_provider_configs"."supersedes_id" IS NULL OR "taxonomy_provider_configs"."supersedes_id" <> "taxonomy_provider_configs"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_provider_configs_name_revision_unique` ON `taxonomy_provider_configs` (`name`,`revision`);--> statement-breakpoint
CREATE INDEX `taxonomy_provider_configs_routing_idx` ON `taxonomy_provider_configs` (`enabled`,`routing_group`,`routing_priority`);--> statement-breakpoint
CREATE TABLE `taxonomy_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`published_version` integer DEFAULT 1 NOT NULL,
	`active_provider_config_id` integer,
	`active_policy_config_id` integer,
	`mode` text DEFAULT 'disabled' NOT NULL,
	`circuit_state` text DEFAULT 'closed' NOT NULL,
	`circuit_reason` text,
	`circuit_opened_at` integer,
	`mode_changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`active_provider_config_id`) REFERENCES `taxonomy_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`active_policy_config_id`) REFERENCES `taxonomy_policy_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_state_singleton_check" CHECK("taxonomy_state"."id" = 1),
	CONSTRAINT "taxonomy_state_version_check" CHECK("taxonomy_state"."published_version" >= 1),
	CONSTRAINT "taxonomy_state_mode_check" CHECK("taxonomy_state"."mode" IN ('disabled', 'shadow', 'gradual', 'autonomous', 'degraded')),
	CONSTRAINT "taxonomy_state_circuit_check" CHECK("taxonomy_state"."circuit_state" IN ('closed', 'open', 'half_open') AND (("taxonomy_state"."circuit_state" = 'closed' AND "taxonomy_state"."circuit_opened_at" IS NULL) OR ("taxonomy_state"."circuit_state" <> 'closed' AND "taxonomy_state"."circuit_opened_at" IS NOT NULL)))
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_active_submission_insert_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_active_submission_update_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `submissions_status_site_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `submissions_existing_site_insert_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `submissions_existing_site_update_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_open_submission_insert_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_open_submission_update_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_json_values_insert_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `sites_json_values_update_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tags_slug_insert_check`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tags_slug_update_check`;--> statement-breakpoint
CREATE TABLE `_taxonomy_backup_tag_aliases` AS SELECT `id`, `alias`, `tag_id` FROM `tag_aliases`;--> statement-breakpoint
CREATE TABLE `_taxonomy_backup_tag_parents` AS SELECT `parent_tag_id`, `child_tag_id` FROM `tag_parents`;--> statement-breakpoint
CREATE TABLE `_taxonomy_backup_site_tags` AS
SELECT min(rowid) AS `id`, `site_id`, `tag_id`, min(`raw_name`) AS `raw_name`
FROM `site_tags` GROUP BY `site_id`, `tag_id`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`canonical` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`automation_locked` integer DEFAULT false NOT NULL,
	`merged_into_tag_id` integer,
	`deprecated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`merged_into_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tags_slug_nonempty_check" CHECK(length(trim("__new_tags"."slug")) > 0),
	CONSTRAINT "tags_name_nonempty_check" CHECK(length(trim("__new_tags"."name")) > 0),
	CONSTRAINT "tags_canonical_check" CHECK("__new_tags"."canonical" IN (0, 1)),
	CONSTRAINT "tags_automation_locked_check" CHECK("__new_tags"."automation_locked" IN (0, 1)),
	CONSTRAINT "tags_status_check" CHECK("__new_tags"."status" IN ('active', 'deprecated', 'merged')),
	CONSTRAINT "tags_revision_check" CHECK("__new_tags"."revision" >= 1),
	CONSTRAINT "tags_lifecycle_check" CHECK(("__new_tags"."status" = 'active' AND "__new_tags"."deprecated_at" IS NULL AND "__new_tags"."merged_into_tag_id" IS NULL) OR ("__new_tags"."status" = 'deprecated' AND "__new_tags"."deprecated_at" IS NOT NULL AND "__new_tags"."merged_into_tag_id" IS NULL) OR ("__new_tags"."status" = 'merged' AND "__new_tags"."deprecated_at" IS NOT NULL AND "__new_tags"."merged_into_tag_id" IS NOT NULL AND "__new_tags"."merged_into_tag_id" <> "__new_tags"."id"))
);
--> statement-breakpoint
INSERT INTO `__new_tags`("id", "slug", "name", "canonical", "status", "revision", "automation_locked", "merged_into_tag_id", "deprecated_at", "created_at", "updated_at") SELECT "id", "slug", "name", "canonical", 'active', 1, 0, NULL, NULL, "created_at", "created_at" FROM `tags`;--> statement-breakpoint
DROP TABLE `tags`;--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
CREATE INDEX `tags_status_canonical_idx` ON `tags` (`status`,`canonical`);--> statement-breakpoint
CREATE INDEX `tags_merged_into_idx` ON `tags` (`merged_into_tag_id`) WHERE "tags"."merged_into_tag_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_site_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`raw_name` text NOT NULL,
	`source` text DEFAULT 'deterministic' NOT NULL,
	`decision_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `tag_assignment_decisions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "site_tags_raw_name_check" CHECK(length(trim("__new_site_tags"."raw_name")) > 0),
	CONSTRAINT "site_tags_source_check" CHECK("__new_site_tags"."source" IN ('deterministic', 'automation', 'admin', 'migration')),
	CONSTRAINT "site_tags_revision_check" CHECK("__new_site_tags"."revision" >= 1)
);
--> statement-breakpoint
DROP TABLE `site_tags`;--> statement-breakpoint
ALTER TABLE `__new_site_tags` RENAME TO `site_tags`;--> statement-breakpoint
CREATE UNIQUE INDEX `site_tags_site_tag_unique` ON `site_tags` (`site_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `site_tags_tag_idx` ON `site_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `site_tags_effective_idx` ON `site_tags` (`site_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `site_tags_decision_idx` ON `site_tags` (`decision_id`) WHERE "site_tags"."decision_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_sites` (
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
	`submission_id` integer,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`content_version` integer DEFAULT 1 NOT NULL,
	`classification_input_hash` text,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sites_status_check" CHECK("__new_sites"."status" IN ('active', 'archived')),
	CONSTRAINT "sites_source_check" CHECK("__new_sites"."source" IN ('Directory', 'Submission', 'Manual')),
	CONSTRAINT "sites_submission_source_check" CHECK(("__new_sites"."source" = 'Submission') = ("__new_sites"."submission_id" IS NOT NULL)),
	CONSTRAINT "sites_visits_nonnegative_check" CHECK("__new_sites"."visits" >= 0),
	CONSTRAINT "sites_content_version_check" CHECK("__new_sites"."content_version" >= 1),
	CONSTRAINT "sites_classification_hash_check" CHECK("__new_sites"."classification_input_hash" IS NULL OR length("__new_sites"."classification_input_hash") = 64),
	CONSTRAINT "sites_categories_json_check" CHECK(json_valid("__new_sites"."categories") AND json_type("__new_sites"."categories") = 'array'),
	CONSTRAINT "sites_notes_json_check" CHECK(json_valid("__new_sites"."notes") AND json_type("__new_sites"."notes") = 'array'),
	CONSTRAINT "sites_facts_json_check" CHECK(json_valid("__new_sites"."facts") AND json_type("__new_sites"."facts") = 'array')
);
--> statement-breakpoint
INSERT INTO `__new_sites`("id", "slug", "name", "url", "url_key", "description", "summary", "categories", "poster", "notes", "facts", "accent", "thumbnail_key", "thumbnail_alt", "visits", "status", "source", "submission_id", "added_at", "created_at", "updated_at", "content_version", "classification_input_hash") SELECT "id", "slug", "name", "url", "url_key", "description", "summary", "categories", "poster", "notes", "facts", "accent", "thumbnail_key", "thumbnail_alt", "visits", "status", "source", "submission_id", "added_at", "created_at", "created_at", 1, NULL FROM `sites`;--> statement-breakpoint
DROP TABLE `sites`;--> statement-breakpoint
ALTER TABLE `__new_sites` RENAME TO `sites`;--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_unique` ON `sites` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_unique` ON `sites` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_key_unique` ON `sites` (`url_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_submission_unique` ON `sites` (`submission_id`);--> statement-breakpoint
CREATE INDEX `sites_status_added_idx` ON `sites` (`status`,`added_at`);--> statement-breakpoint
CREATE INDEX `sites_status_visits_idx` ON `sites` (`status`,`visits`);--> statement-breakpoint
CREATE INDEX `sites_thumbnail_key_idx` ON `sites` (`thumbnail_key`) WHERE "sites"."thumbnail_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sites_classification_input_idx` ON `sites` (`classification_input_hash`,`content_version`);--> statement-breakpoint
INSERT INTO `tag_aliases` (`id`, `alias`, `tag_id`)
SELECT `id`, `alias`, `tag_id` FROM `_taxonomy_backup_tag_aliases`;--> statement-breakpoint
INSERT INTO `tag_parents` (`parent_tag_id`, `child_tag_id`)
SELECT `parent_tag_id`, `child_tag_id` FROM `_taxonomy_backup_tag_parents`;--> statement-breakpoint
INSERT INTO `site_tags` (`id`, `site_id`, `tag_id`, `raw_name`, `source`, `decision_id`, `revision`, `created_at`, `updated_at`)
SELECT `id`, `site_id`, `tag_id`, `raw_name`, 'migration', NULL, 1, unixepoch(), unixepoch()
FROM `_taxonomy_backup_site_tags`;--> statement-breakpoint
DROP TABLE `_taxonomy_backup_tag_aliases`;--> statement-breakpoint
DROP TABLE `_taxonomy_backup_tag_parents`;--> statement-breakpoint
DROP TABLE `_taxonomy_backup_site_tags`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
CREATE TRIGGER `tags_slug_insert_check` BEFORE INSERT ON `tags`
WHEN length(trim(NEW.`slug`)) = 0 OR NEW.`canonical` NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'invalid tag'); END;--> statement-breakpoint
CREATE TRIGGER `tags_slug_update_check` BEFORE UPDATE OF `slug`, `canonical` ON `tags`
WHEN length(trim(NEW.`slug`)) = 0 OR NEW.`canonical` NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'invalid tag'); END;--> statement-breakpoint
CREATE TRIGGER `tag_aliases_integrity_insert_check` BEFORE INSERT ON `tag_aliases`
WHEN NEW.`alias` <> lower(trim(NEW.`alias`)) OR length(NEW.`alias`) = 0 OR EXISTS (SELECT 1 FROM `tags` WHERE `slug` = NEW.`alias`)
BEGIN SELECT RAISE(ABORT, 'invalid or conflicting tag alias'); END;--> statement-breakpoint
CREATE TRIGGER `tag_aliases_integrity_update_check` BEFORE UPDATE OF `alias`, `tag_id` ON `tag_aliases`
WHEN NEW.`alias` <> lower(trim(NEW.`alias`)) OR length(NEW.`alias`) = 0 OR EXISTS (SELECT 1 FROM `tags` WHERE `slug` = NEW.`alias`)
BEGIN SELECT RAISE(ABORT, 'invalid or conflicting tag alias'); END;--> statement-breakpoint
CREATE TRIGGER `tag_parents_canonical_insert_check` BEFORE INSERT ON `tag_parents`
WHEN NOT EXISTS (SELECT 1 FROM `tags` WHERE `id` = NEW.`parent_tag_id` AND `canonical` = 1 AND `status` = 'active')
OR NOT EXISTS (SELECT 1 FROM `tags` WHERE `id` = NEW.`child_tag_id` AND `canonical` = 1 AND `status` = 'active')
BEGIN SELECT RAISE(ABORT, 'tag parents must be active canonical tags'); END;--> statement-breakpoint
CREATE TRIGGER `tag_parents_canonical_update_check` BEFORE UPDATE OF `parent_tag_id`, `child_tag_id` ON `tag_parents`
WHEN NOT EXISTS (SELECT 1 FROM `tags` WHERE `id` = NEW.`parent_tag_id` AND `canonical` = 1 AND `status` = 'active')
OR NOT EXISTS (SELECT 1 FROM `tags` WHERE `id` = NEW.`child_tag_id` AND `canonical` = 1 AND `status` = 'active')
BEGIN SELECT RAISE(ABORT, 'tag parents must be active canonical tags'); END;--> statement-breakpoint
CREATE TRIGGER `taxonomy_audit_events_immutable_update_check` BEFORE UPDATE ON `taxonomy_audit_events`
BEGIN SELECT RAISE(ABORT, 'taxonomy audit events are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `taxonomy_audit_events_immutable_delete_check` BEFORE DELETE ON `taxonomy_audit_events`
BEGIN SELECT RAISE(ABORT, 'taxonomy audit events are immutable'); END;--> statement-breakpoint
INSERT INTO `taxonomy_policy_configs` (
  `revision`, `assignment_limit`, `novel_evidence_site_threshold`, `assignment_confidence_micros`,
  `ontology_confidence_micros`, `minimum_margin_micros`, `hierarchy_max_depth`, `hierarchy_max_fanout`,
  `ontology_provider_agreement`, `retry_budget`, `retry_base_seconds`, `retry_max_seconds`,
  `rollout_basis_points`, `daily_request_budget`, `daily_token_budget`, `schema_failure_trip_basis_points`,
  `disagreement_trip_basis_points`, `rollback_trip_basis_points`, `mutation_volume_trip_count`,
  `raw_response_retention_seconds`, `shadow_minimum_samples`, `shadow_minimum_coverage_basis_points`,
  `shadow_schema_success_basis_points`, `shadow_provider_agreement_basis_points`, `prompt_hash`, `schema_hash`, `created_by`
) VALUES (1, 12, 3, 850000, 920000, 150000, 3, 24, 2, 5, 60, 3600, 0, 250, 500000,
  500, 2000, 1000, 100, 604800, 20, 9000, 9800, 8000,
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000', 'migration');--> statement-breakpoint
INSERT INTO `taxonomy_state` (`id`, `published_version`, `active_policy_config_id`, `mode`, `circuit_state`)
VALUES (1, 1, 1, 'disabled', 'closed');--> statement-breakpoint
INSERT INTO `taxonomy_change_batches` (`id`, `kind`, `status`, `actor_type`, `expected_taxonomy_version`, `resulting_taxonomy_version`, `summary`, `applied_at`, `completed_at`)
VALUES ('taxonomy-migration-v1', 'migration', 'applied', 'migration', 1, 1, 'Imported the existing D1 taxonomy as automation revision 1.', unixepoch(), unixepoch());--> statement-breakpoint
INSERT INTO `taxonomy_audit_events` (`id`, `batch_id`, `event_type`, `entity_type`, `entity_id`, `actor_type`, `actor_id`, `policy_config_id`, `taxonomy_version_before`, `taxonomy_version_after`, `before`, `after`, `release_sha`)
VALUES ('taxonomy-migration-v1-event', 'taxonomy-migration-v1', 'taxonomy_imported', 'taxonomy', '1', 'migration', '0009_sharp_skreet', 1, 1, 1, '{}', '{"publishedVersion":1,"mode":"disabled"}', 'migration');--> statement-breakpoint
CREATE TABLE `_taxonomy_foreign_key_guard` (`violations` integer CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `_taxonomy_foreign_key_guard` SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `_taxonomy_foreign_key_guard`;
