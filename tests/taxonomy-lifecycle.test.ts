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

test('site metadata hashing is normalized, stable, and excludes website data', async () => {
  const left = {
    name: ' Odd\u00a0Site ',
    description: 'A\nstrange directory',
    summary: '  Short summary ',
    notes: [' First note ', 'Second\tnote'],
    facts: [{ label: ' Medium ', value: ' Audio ' }],
    rawTagHints: [' Radio ', 'CALM', 'radio'],
  }
  const right = {
    name: 'Odd Site',
    description: 'A strange directory',
    summary: 'Short summary',
    notes: ['First note', 'Second note'],
    facts: [{ label: 'Medium', value: 'Audio' }],
    rawTagHints: ['calm', 'RADIO'],
  }

  assert.deepEqual(normalizeSiteTaxonomyMetadata(left), {
    name: 'Odd Site',
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
  assert.deepEqual(preserveRawTagHints([' Radio ', 'radio', ' Radio ']), [
    'Radio',
    'radio',
  ])
})

test('exact hint resolution prefers canonical slug, name, and alias targets', () => {
  const tags = [
    { id: 1, slug: 'listen', name: 'Listen', canonical: 1, status: 'active' },
    {
      id: 2,
      slug: 'radio',
      name: 'Radio copy',
      canonical: 0,
      status: 'active',
    },
    { id: 3, slug: 'calm', name: 'Quiet', canonical: 1, status: 'active' },
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
      `INSERT INTO taxonomy_policy_configs (id, retry_budget) VALUES (7, 4)`,
    ),
    db.prepare(
      `INSERT INTO taxonomy_state (
         id, published_version, active_provider_config_id, active_policy_config_id, mode
       ) VALUES (1, 3, NULL, 7, 'disabled')`,
    ),
  ])
  const metadataHash = await hashSiteTaxonomyMetadata({
    name: 'Odd Site',
    description: 'Signals from elsewhere.',
    summary: 'Signals.',
    notes: ['No fetch involved.'],
    facts: [{ label: 'Medium', value: 'Audio' }],
    rawTagHints: ['Radio', 'Dream Signal'],
  })
  const lifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'id', value: 1 },
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

  const failedLifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'slug', value: 'never-created' },
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
  classification_input_hash TEXT
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  canonical INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE tag_aliases (alias TEXT PRIMARY KEY, tag_id INTEGER NOT NULL);
CREATE TABLE site_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
  raw_name TEXT NOT NULL, source TEXT NOT NULL, decision_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(site_id, tag_id)
);
CREATE TABLE taxonomy_policy_configs (id INTEGER PRIMARY KEY, retry_budget INTEGER NOT NULL);
CREATE TABLE taxonomy_state (
  id INTEGER PRIMARY KEY, published_version INTEGER NOT NULL, active_provider_config_id INTEGER,
  active_policy_config_id INTEGER, mode TEXT NOT NULL
);
CREATE TABLE taxonomy_jobs (
  id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, site_id INTEGER,
  input_hash TEXT NOT NULL, site_content_version INTEGER, taxonomy_version INTEGER NOT NULL,
  provider_config_id INTEGER, policy_config_id INTEGER, status TEXT NOT NULL,
  max_attempts INTEGER NOT NULL
);
CREATE TABLE taxonomy_outbox (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
);
CREATE TABLE taxonomy_concept_evidence (
  id TEXT PRIMARY KEY, normalized_concept TEXT NOT NULL, site_id INTEGER NOT NULL,
  input_hash TEXT NOT NULL, source_key TEXT NOT NULL, source TEXT NOT NULL,
  policy_config_id INTEGER, job_id TEXT, evidence_hash TEXT NOT NULL,
  evidence_snippet TEXT NOT NULL, confidence_micros INTEGER NOT NULL, accepted INTEGER NOT NULL,
  UNIQUE(normalized_concept, site_id, input_hash, source_key)
);
`
