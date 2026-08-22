import assert from 'node:assert/strict'
import test from 'node:test'

import { migratedTaxonomyDb } from './taxonomy-test-db'

async function queryPlan(
  db: D1Database,
  sql: string,
  bindings: unknown[] = [],
) {
  const result = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...bindings)
    .all<{ detail: string }>()

  return result.results.map((row) => row.detail).join('\n')
}

test('concept eligibility avoids correlated taxonomy history scans', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const plan = await queryPlan(
    db,
    `SELECT evidence.normalized_concept AS concept
     FROM taxonomy_concept_evidence evidence
     WHERE evidence.accepted = 1
     GROUP BY evidence.normalized_concept
     HAVING count(DISTINCT evidence.site_id) >= ?
        AND NOT EXISTS (
          SELECT 1 FROM taxonomy_jobs job
          WHERE job.kind = 'reassess_concept'
            AND job.concept_key = evidence.normalized_concept
            AND job.taxonomy_version = ?
            AND job.provider_config_id IS ?
        )
     ORDER BY min(evidence.observed_at), evidence.normalized_concept
     LIMIT ?`,
    [1, 1, null, 100],
  )

  assert.match(plan, /taxonomy_concept_evidence_accepted_site_idx/)
  assert.match(plan, /taxonomy_jobs_reassess_lookup_idx/)
  assert.doesNotMatch(plan, /SCAN job(?:\s|$)/)
})

test('circuit metrics use bounded history indexes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const plan = await queryPlan(
    db,
    `SELECT
     (SELECT count(*) FROM taxonomy_job_attempts WHERE started_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1))) AS attempts,
     (SELECT count(*) FROM taxonomy_job_attempts WHERE started_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1)) AND status = 'invalid_response') AS schema_failures,
     (SELECT count(*) FROM taxonomy_jobs WHERE kind = 'classify_site' AND updated_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1)) AND status IN ('settled','retry_wait','dead','degraded')) AS classifications,
     (SELECT count(*) FROM taxonomy_jobs WHERE updated_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1)) AND last_error_code = 'provider_disagreement') AS disagreements,
     (SELECT count(*) FROM taxonomy_change_batches WHERE created_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1)) AND kind = 'rollback' AND status IN ('applied','partial')) AS rollbacks,
     (SELECT count(*) FROM taxonomy_audit_events WHERE created_at > max(?, (SELECT mode_changed_at FROM taxonomy_state WHERE id = 1)) AND event_type IN ('assignment_add','assignment_remove','canonical_created','alias_created','tags_merged','parent_created')) AS mutations`,
    [0, 0, 0, 0, 0, 0],
  )

  assert.match(plan, /taxonomy_job_attempts_circuit_window_idx/)
  assert.match(plan, /taxonomy_jobs_classification_window_idx/)
  assert.match(plan, /taxonomy_jobs_disagreement_window_idx/)
  assert.match(plan, /taxonomy_audit_events_mutation_window_idx/)
  assert.doesNotMatch(
    plan,
    /SCAN taxonomy_(?:job_attempts|jobs|audit_events)(?:\s|$)/,
  )
})
