import assert from 'node:assert/strict'
import test from 'node:test'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

import {
  hashSiteTaxonomyMetadata,
  normalizeSiteTaxonomyMetadata,
  prepareSiteTaxonomyLifecycle,
  preserveRawTagHints,
  resolveTaxonomyHints,
} from '../src/taxonomy/lifecycle'
import { sha256Hex, stableJson } from '../src/taxonomy/normalize'

test('site metadata hashing normalizes content and website URLs', async () => {
  const left = {
    name: ' Odd\u00a0Site ',
    url: 'HTTPS://WWW.Example.com/path/?utm_source=test&b=2&a=1#section',
    description: 'A\nstrange directory',
    summary: '  Short summary ',
    notes: [' First note ', 'Second\tnote'],
    facts: [{ label: ' Medium ', value: ' Audio ' }],
    rawTagHints: [' Radio ', 'CALM', 'radio'],
  }
  const right = {
    name: 'Odd Site',
    url: 'https://www.example.com/path?a=1&b=2',
    description: 'A strange directory',
    summary: 'Short summary',
    notes: ['First note', 'Second note'],
    facts: [{ label: 'Medium', value: 'Audio' }],
    rawTagHints: ['calm', 'RADIO'],
  }

  assert.deepEqual(normalizeSiteTaxonomyMetadata(left), {
    name: 'Odd Site',
    url: 'https://www.example.com/path?a=1&b=2',
    description: 'A strange directory',
    summary: 'Short summary',
    notes: ['First note', 'Second note'],
    factsText: ['Medium: Audio'],
    rawHints: ['calm', 'radio'],
  })
  assert.equal(
    await hashSiteTaxonomyMetadata(left),
    await hashSiteTaxonomyMetadata(right),
  )
  assert.notEqual(
    await hashSiteTaxonomyMetadata(left),
    await hashSiteTaxonomyMetadata({
      ...right,
      url: 'https://www.example.com/other',
    }),
  )
  assert.deepEqual(preserveRawTagHints([' Radio ', 'radio', ' Radio ']), [
    'Radio',
    'radio',
  ])
})

test('exact hint resolution prefers canonical slug, name, and alias targets', () => {
  const tags = [
    {
      id: 1,
      slug: 'listen',
      name: 'Listen',
      canonical: 1,
      status: 'active',
      revision: 1,
    },
    {
      id: 2,
      slug: 'radio',
      name: 'Radio copy',
      canonical: 0,
      status: 'active',
      revision: 1,
    },
    {
      id: 3,
      slug: 'calm',
      name: 'Quiet',
      canonical: 1,
      status: 'active',
      revision: 1,
    },
  ]
  const aliases = [{ alias: 'radio', tagId: 1 }]

  assert.deepEqual(
    resolveTaxonomyHints(
      [' Listen ', 'radio', 'Quiet', 'Dream Signal'],
      tags,
      aliases,
    ),
    [
      {
        tagId: 1,
        slug: 'listen',
        rawName: 'Listen',
        normalizedConcept: 'listen',
        novel: false,
      },
      {
        tagId: 3,
        slug: 'calm',
        rawName: 'Quiet',
        normalizedConcept: 'quiet',
        novel: false,
      },
      {
        slug: 'dream-signal',
        rawName: 'Dream Signal',
        normalizedConcept: 'dream signal',
        novel: true,
      },
    ],
  )
})

test('D1 lifecycle batch atomically assigns tags and creates an idempotent pending outbox job', async (context) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-14',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  )
  context.after(() => mf.dispose())
  const db = await mf.getD1Database('DB')
  await db.exec(schema.replace(/\s+/g, ' '))
  await db.batch([
    db.prepare(
      `INSERT INTO sites (id, slug, content_version) VALUES (1, 'odd-site', 1)`,
    ),
    db.prepare(
      `INSERT INTO tags (id, slug, name, canonical, status)
       VALUES (1, 'listen', 'Listen', 1, 'active'),
              (2, 'calm', 'Calm', 1, 'active')`,
    ),
    db.prepare(`INSERT INTO tag_aliases (alias, tag_id) VALUES ('radio', 1)`),
    db.prepare(
      `INSERT INTO taxonomy_policy_configs
       (id, retry_budget, novel_evidence_site_threshold) VALUES (7, 4, 2)`,
    ),
    db.prepare(
      `INSERT INTO taxonomy_state (
         id, published_version, active_provider_config_id, active_policy_config_id, mode
       ) VALUES (1, 3, NULL, 7, 'disabled')`,
    ),
  ])
  const metadataHash = await hashSiteTaxonomyMetadata({
    name: 'Odd Site',
    url: 'https://odd.example/',
    description: 'Signals from elsewhere.',
    summary: 'Signals.',
    notes: ['No fetch involved.'],
    facts: [{ label: 'Medium', value: 'Audio' }],
    rawTagHints: ['Radio', 'Dream Signal'],
  })
  const lifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'id', value: 1 },
    expectedTaxonomyVersion: 3,
    metadataHash,
    contentVersion: 2,
    rawTagHints: ['Radio', 'Dream Signal'],
    assignmentSource: 'admin',
    enqueueClassification: true,
  })

  await db.batch([
    db
      .prepare(
        `UPDATE sites SET content_version = 2, classification_input_hash = ?1
         WHERE id = 1`,
      )
      .bind(metadataHash),
    ...lifecycle,
  ])
  await db.batch(
    await prepareSiteTaxonomyLifecycle(db, {
      target: { kind: 'id', value: 1 },
      expectedTaxonomyVersion: 3,
      metadataHash,
      contentVersion: 2,
      rawTagHints: ['Radio', 'Dream Signal'],
      assignmentSource: 'admin',
      enqueueClassification: true,
    }),
  )

  const assignments = await db
    .prepare(
      `SELECT tag.slug, assignment.raw_name AS rawName, assignment.source
       FROM site_tags assignment JOIN tags tag ON tag.id = assignment.tag_id
       ORDER BY tag.slug`,
    )
    .all<{ slug: string; rawName: string; source: string }>()
  assert.deepEqual(assignments.results, [
    { slug: 'dream-signal', rawName: 'Dream Signal', source: 'admin' },
    { slug: 'listen', rawName: 'Radio', source: 'admin' },
  ])
  const jobs = await db
    .prepare(
      `SELECT status, provider_config_id AS providerConfigId,
              policy_config_id AS policyConfigId, taxonomy_version AS taxonomyVersion,
              site_content_version AS siteContentVersion, max_attempts AS maxAttempts
       FROM taxonomy_jobs`,
    )
    .all()
  assert.deepEqual(jobs.results, [
    {
      status: 'pending',
      providerConfigId: null,
      policyConfigId: 7,
      taxonomyVersion: 3,
      siteContentVersion: 2,
      maxAttempts: 5,
    },
  ])
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS count FROM taxonomy_jobs')
        .first<{ count: number }>()
    )?.count,
    1,
  )
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS count FROM taxonomy_outbox')
        .first<{ count: number }>()
    )?.count,
    1,
  )
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS count FROM taxonomy_concept_evidence')
        .first<{
          count: number
        }>()
    )?.count,
    1,
  )

  const conceptInputHash = await sha256Hex(
    stableJson({ concept: 'dream signal' }),
  )
  const conceptJobKey = `concept:dream%20signal:input:${conceptInputHash}:taxonomy:3:provider:0`
  await db.batch([
    db
      .prepare(
        `INSERT INTO taxonomy_jobs
         (id, job_key, kind, concept_key, input_hash, taxonomy_version,
          policy_config_id, status, attempt_count, max_attempts, available_at,
          last_error_code, last_error_summary, created_at, updated_at, completed_at)
         VALUES ('terminal-concept-job', ?, 'reassess_concept', 'dream signal', ?, 3,
                 7, 'degraded', 1, 1, 100, 'automation_disabled', 'disabled',
                 100, 100, 100)`,
      )
      .bind(conceptJobKey, conceptInputHash),
    db.prepare(
      `INSERT INTO taxonomy_outbox
       (id, job_id, payload, available_at, dispatched_at, last_error, created_at)
       VALUES ('terminal-concept-outbox', 'terminal-concept-job',
               '{"jobId":"terminal-concept-job"}', 100, 100, 'sent', 100)`,
    ),
  ])

  await db
    .prepare(
      `INSERT INTO sites (id, slug, content_version) VALUES (2, 'second', 1)`,
    )
    .run()
  const secondHash = await hashSiteTaxonomyMetadata({
    name: 'Second Site',
    url: 'https://second.example/',
    description: 'Another independent signal.',
    summary: '',
    notes: [],
    facts: [],
    rawTagHints: ['Dream-Signal'],
  })
  const secondLifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'id', value: 2 },
    expectedTaxonomyVersion: 3,
    metadataHash: secondHash,
    contentVersion: 1,
    rawTagHints: ['Dream-Signal'],
    assignmentSource: 'admin',
    enqueueClassification: true,
  })
  await db.batch(secondLifecycle)
  await db.batch(
    await prepareSiteTaxonomyLifecycle(db, {
      target: { kind: 'id', value: 2 },
      expectedTaxonomyVersion: 3,
      metadataHash: secondHash,
      contentVersion: 1,
      rawTagHints: ['Dream-Signal'],
      assignmentSource: 'admin',
      enqueueClassification: true,
    }),
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(DISTINCT site_id) FROM taxonomy_concept_evidence
         WHERE normalized_concept = 'dream signal'`,
      )
      .first('count(DISTINCT site_id)'),
    2,
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT id, kind, concept_key AS conceptKey, status,
                attempt_count AS attemptCount, completed_at AS completedAt,
                last_error_code AS lastErrorCode
         FROM taxonomy_jobs WHERE kind = 'reassess_concept'`,
      )
      .first(),
    {
      id: 'terminal-concept-job',
      kind: 'reassess_concept',
      conceptKey: 'dream signal',
      status: 'pending',
      attemptCount: 0,
      completedAt: null,
      lastErrorCode: null,
    },
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT dispatched_at AS dispatchedAt, lease_token AS leaseToken,
                last_error AS lastError
         FROM taxonomy_outbox WHERE job_id = 'terminal-concept-job'`,
      )
      .first(),
    { dispatchedAt: null, leaseToken: null, lastError: null },
  )
  await db.batch([
    db.prepare(
      `UPDATE taxonomy_jobs SET status = 'settled', completed_at = 200,
       attempt_count = 1 WHERE id = 'terminal-concept-job'`,
    ),
    db.prepare(
      `UPDATE taxonomy_outbox SET dispatched_at = 200
       WHERE job_id = 'terminal-concept-job'`,
    ),
  ])
  await db.batch(
    await prepareSiteTaxonomyLifecycle(db, {
      target: { kind: 'id', value: 2 },
      expectedTaxonomyVersion: 3,
      metadataHash: secondHash,
      contentVersion: 1,
      rawTagHints: ['Dream-Signal'],
      assignmentSource: 'admin',
      enqueueClassification: true,
    }),
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT status, completed_at AS completedAt
         FROM taxonomy_jobs WHERE id = 'terminal-concept-job'`,
      )
      .first(),
    { status: 'settled', completedAt: 200 },
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept'`,
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM taxonomy_outbox').first('count(*)'),
    3,
  )

  const guardedLifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'id', value: 1 },
    expectedTaxonomyVersion: 3,
    metadataHash,
    contentVersion: 3,
    rawTagHints: ['Radio'],
    assignmentSource: 'admin',
    enqueueClassification: false,
  })
  await db.prepare('UPDATE tags SET revision = revision + 1 WHERE id = 1').run()
  await assert.rejects(
    db.batch([
      db.prepare('UPDATE sites SET content_version = 3 WHERE id = 1'),
      ...guardedLifecycle,
    ]),
  )
  assert.equal(
    await db
      .prepare('SELECT content_version FROM sites WHERE id = 1')
      .first('content_version'),
    2,
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT tag.slug FROM site_tags assignment
           JOIN tags tag ON tag.id = assignment.tag_id
           WHERE assignment.site_id = 1 ORDER BY tag.slug`,
        )
        .all()
    ).results,
    [{ slug: 'dream-signal' }, { slug: 'listen' }],
  )

  const failedLifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'slug', value: 'never-created' },
    expectedTaxonomyVersion: 3,
    metadataHash: 'f'.repeat(64),
    contentVersion: 1,
    rawTagHints: ['Orphan Concept'],
    assignmentSource: 'admin',
    enqueueClassification: true,
  })
  await assert.rejects(
    db.batch([
      db.prepare(`INSERT INTO sites (id, slug) VALUES (1, 'duplicate')`),
      ...failedLifecycle,
    ]),
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) AS count FROM tags WHERE slug = 'orphan-concept'`,
      )
      .first('count'),
    0,
  )
})

const schema = `
CREATE TABLE sites (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, content_version INTEGER NOT NULL,
  classification_input_hash TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  canonical INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  merged_into_tag_id INTEGER
);
CREATE TABLE tag_aliases (alias TEXT PRIMARY KEY, tag_id INTEGER NOT NULL);
CREATE TABLE site_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
  raw_name TEXT NOT NULL, source TEXT NOT NULL, decision_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(site_id, tag_id)
);
CREATE TABLE taxonomy_policy_configs (
  id INTEGER PRIMARY KEY, retry_budget INTEGER NOT NULL,
  novel_evidence_site_threshold INTEGER NOT NULL
);
CREATE TABLE taxonomy_state (
  id INTEGER PRIMARY KEY, published_version INTEGER NOT NULL, active_provider_config_id INTEGER,
  active_policy_config_id INTEGER, mode TEXT NOT NULL
);
CREATE TABLE taxonomy_jobs (
  id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, site_id INTEGER,
  concept_key TEXT,
  input_hash TEXT NOT NULL, site_content_version INTEGER, taxonomy_version INTEGER NOT NULL,
  provider_config_id INTEGER, policy_config_id INTEGER, status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_owner TEXT, lease_token TEXT, leased_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
  last_error_code TEXT, last_error_summary TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()), completed_at INTEGER
);
CREATE TABLE taxonomy_outbox (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
  available_at INTEGER NOT NULL DEFAULT (unixepoch()), lease_token TEXT,
  leased_until INTEGER, dispatched_at INTEGER, last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE taxonomy_concept_evidence (
  id TEXT PRIMARY KEY, normalized_concept TEXT NOT NULL, site_id INTEGER NOT NULL,
  input_hash TEXT NOT NULL, source_key TEXT NOT NULL, source TEXT NOT NULL,
  policy_config_id INTEGER, job_id TEXT, evidence_hash TEXT NOT NULL,
  evidence_snippet TEXT NOT NULL, confidence_micros INTEGER NOT NULL, accepted INTEGER NOT NULL,
  observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(normalized_concept, site_id, input_hash, source_key)
);
`
