import assert from 'node:assert/strict'
import test from 'node:test'

import { TaxonomyService } from '../src/taxonomy'
import { resolveTaxonomyHints } from '../src/taxonomy/lifecycle'
import {
  insertSite,
  insertTag,
  masterKey,
  migratedTaxonomyDb,
} from './taxonomy-test-db'

function service(db: D1Database, now = 20_000_000) {
  return new TaxonomyService(
    {
      DB: db,
      RELEASE_SHA: 'admin-correction-test',
      TAXONOMY_MASTER_KEY_V1: masterKey,
    },
    { now: () => now },
  )
}

test('admin tag correction audits, versions, locks, revises, and obsoletes old work atomically', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  await insertTag(db, 2, 'parent')
  const taxonomy = service(db)
  const jobId = await taxonomy.enqueueSite(1)
  assert.ok(jobId)

  const result = await taxonomy.correctTag({
    id: 1,
    name: 'Corrected Tag',
    aliases: ['Corrected Alias'],
    parents: ['parent'],
    actorId: 'admin@example.com',
  })

  assert.equal(result.version, 2)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT name, canonical, revision, automation_locked AS automationLocked
         FROM tags WHERE id = 1`,
      )
      .first(),
    {
      name: 'Corrected Tag',
      canonical: 1,
      revision: 2,
      automationLocked: 1,
    },
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    2,
  )
  assert.equal(
    await db
      .prepare('SELECT status FROM taxonomy_jobs WHERE id = ?')
      .bind(jobId)
      .first('status'),
    'obsolete',
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT scope, resource_key AS resourceKey, created_by AS createdBy
           FROM taxonomy_locks WHERE released_at IS NULL ORDER BY resource_key`,
        )
        .all()
    ).results,
    [
      {
        scope: 'alias',
        resourceKey: 'alias:corrected alias',
        createdBy: 'admin@example.com',
      },
      {
        scope: 'parent_edge',
        resourceKey: 'parent:2:1',
        createdBy: 'admin@example.com',
      },
      { scope: 'tag', resourceKey: 'tag:1', createdBy: 'admin@example.com' },
    ],
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId, event_type AS eventType,
                taxonomy_version_before AS versionBefore, taxonomy_version_after AS versionAfter
         FROM taxonomy_audit_events WHERE event_type = 'admin_tag_corrected'`,
      )
      .first(),
    {
      actorType: 'admin',
      actorId: 'admin@example.com',
      eventType: 'admin_tag_corrected',
      versionBefore: 1,
      versionAfter: 2,
    },
  )
})

test('admin corrections enforce active locks and hierarchy policy without partial writes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2, 'parent')
  await db
    .prepare(
      'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (1, 2)',
    )
    .run()
  const taxonomy = service(db)

  await assert.rejects(
    taxonomy.correctTag({
      id: 1,
      name: 'Cycle',
      aliases: [],
      parents: ['parent'],
      actorId: 'admin',
    }),
    /cycle, depth, or fanout/i,
  )
  const lockId = await taxonomy.createLock({
    scope: 'tag',
    tagId: 1,
    reason: 'review pending',
    actorId: 'reviewer',
  })
  await assert.rejects(
    taxonomy.correctTag({
      id: 1,
      name: 'Blocked',
      aliases: [],
      parents: [],
      actorId: 'admin',
    }),
    /active lock/i,
  )
  assert.equal(await taxonomy.releaseLock(lockId, 'reviewer', 'done'), true)
  assert.equal(
    await db
      .prepare('SELECT revision FROM tags WHERE id = 1')
      .first('revision'),
    1,
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    1,
  )
})

test('concurrent admin corrections use taxonomy version CAS', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2)
  const taxonomy = service(db)

  const results = await Promise.allSettled([
    taxonomy.correctTag({
      id: 1,
      name: 'First correction',
      aliases: [],
      parents: [],
      actorId: 'admin-one',
    }),
    taxonomy.correctTag({
      id: 2,
      name: 'Second correction',
      aliases: [],
      parents: [],
      actorId: 'admin-two',
    }),
  ])

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    2,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'admin_tag_corrected'",
      )
      .first('count(*)'),
    1,
  )
})

test('releasing the final applicable lock clears automation locking atomically', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2, 'parent')
  const taxonomy = service(db)
  await taxonomy.correctTag({
    id: 1,
    name: 'Locked correction',
    aliases: ['locked alias'],
    parents: ['parent'],
    actorId: 'admin',
  })
  const locks = (
    await db
      .prepare(
        `SELECT id, resource_key AS resourceKey FROM taxonomy_locks
         WHERE released_at IS NULL ORDER BY resource_key`,
      )
      .all<{ id: string; resourceKey: string }>()
  ).results
  assert.equal(locks.length, 3)
  assert.equal(
    await taxonomy.releaseLock(locks[0].id, 'admin', 'partial release'),
    true,
  )
  assert.equal(
    await db
      .prepare('SELECT automation_locked FROM tags WHERE id = 1')
      .first('automation_locked'),
    1,
  )
  for (const lock of locks.slice(1)) {
    assert.equal(
      await taxonomy.releaseLock(lock.id, 'admin', 'correction retired'),
      true,
    )
  }
  assert.deepEqual(
    await db
      .prepare(
        `SELECT automation_locked AS automationLocked, revision
         FROM tags WHERE id = 1`,
      )
      .first(),
    { automationLocked: 0, revision: 3 },
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_audit_events
         WHERE event_type = 'lock_released'`,
      )
      .first('count(*)'),
    3,
  )
})

test('admin merge preserves a tombstone, assignment provenance, hierarchy, audit, version, and locks', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  for (let id = 1; id <= 4; id += 1) await insertTag(db, id)
  await db
    .prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
       VALUES (1, 1, 'Human wording', 'admin'), (1, 2, 'Machine wording', 'automation')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (3, 1), (1, 4)`,
    )
    .run()
  const taxonomy = service(db)

  const result = await taxonomy.correctMerge({
    sourceId: 1,
    targetId: 2,
    actorId: 'merger',
  })

  assert.equal(result.version, 2)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT status, canonical, merged_into_tag_id AS mergedIntoTagId,
                revision, automation_locked AS automationLocked FROM tags WHERE id = 1`,
      )
      .first(),
    {
      status: 'merged',
      canonical: 0,
      mergedIntoTagId: 2,
      revision: 2,
      automationLocked: 1,
    },
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM tags WHERE id = 1')
      .first('count(*)'),
    1,
  )
  assert.deepEqual(
    await db
      .prepare(
        'SELECT raw_name AS rawName, source FROM site_tags WHERE site_id = 1 AND tag_id = 2',
      )
      .first(),
    { rawName: 'Human wording', source: 'admin' },
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT parent_tag_id AS parentId, child_tag_id AS childId
           FROM tag_parents ORDER BY parent_tag_id, child_tag_id`,
        )
        .all()
    ).results,
    [
      { parentId: 2, childId: 4 },
      { parentId: 3, childId: 2 },
    ],
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'admin_tags_merged' AND actor_type = 'admin' AND actor_id = 'merger'",
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM taxonomy_locks WHERE released_at IS NULL')
      .first('count(*)'),
    6,
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT resource_key AS resourceKey, tag_id AS tagId,
                  related_tag_id AS relatedTagId
           FROM taxonomy_locks WHERE scope = 'parent_edge' ORDER BY resource_key`,
        )
        .all()
    ).results,
    [
      { resourceKey: 'parent:2:4', tagId: 2, relatedTagId: 4 },
      { resourceKey: 'parent:3:2', tagId: 3, relatedTagId: 2 },
    ],
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    2,
  )
})

test('admin merge explicitly refuses more than 500 affected rows', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2)
  await db.prepare('UPDATE tags SET canonical = 0 WHERE id = 1').run()
  for (let id = 1; id <= 501; id += 1) {
    await insertSite(db, id)
    await db
      .prepare(
        `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
         VALUES (?, 1, 'Source', 'admin')`,
      )
      .bind(id)
      .run()
  }
  const taxonomy = service(db)

  await assert.rejects(
    taxonomy.correctMerge({ sourceId: 1, targetId: 2, actorId: 'admin' }),
    /500 affected rows/i,
  )
  assert.equal(
    await db.prepare('SELECT status FROM tags WHERE id = 1').first('status'),
    'active',
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    1,
  )
})

test('admin merge preserves a source slug identifier without a conflicting alias', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1, 'audio')
  await insertTag(db, 2, 'listening')
  await db.prepare("UPDATE tags SET name = 'Audio' WHERE id = 1").run()
  const taxonomy = service(db)

  const result = await taxonomy.correctMerge({
    sourceId: 1,
    targetId: 2,
    actorId: 'merger',
  })
  assert.equal(result.version, 2)
  assert.equal(
    await db
      .prepare("SELECT count(*) FROM tag_aliases WHERE alias = 'audio'")
      .first('count(*)'),
    0,
  )
  const tags = (
    await db
      .prepare(
        `SELECT id, slug, name, canonical, status,
                merged_into_tag_id AS mergedIntoTagId FROM tags ORDER BY id`,
      )
      .all<{
        id: number
        slug: string
        name: string
        canonical: number
        status: string
        mergedIntoTagId: number | null
      }>()
  ).results
  const aliases = (
    await db
      .prepare('SELECT alias, tag_id AS tagId FROM tag_aliases')
      .all<{ alias: string; tagId: number }>()
  ).results
  assert.deepEqual(resolveTaxonomyHints(['audio'], tags, aliases), [
    {
      tagId: 2,
      slug: 'listening',
      rawName: 'audio',
      normalizedConcept: 'audio',
      novel: false,
    },
  ])
})

test('admin merge migrates active locks on original source parent edges', async (context) => {
  const db = await migratedTaxonomyDb(context)
  for (let id = 1; id <= 3; id += 1) await insertTag(db, id)
  await db.prepare('INSERT INTO tag_parents VALUES (3, 1)').run()
  await db
    .prepare(
      `INSERT INTO taxonomy_locks
     (id, scope, resource_key, tag_id, related_tag_id, reason, created_by)
     VALUES ('source-edge-lock', 'parent_edge', 'parent:3:1', 3, 1, 'manual', 'admin')`,
    )
    .run()
  await service(db).correctMerge({
    sourceId: 1,
    targetId: 2,
    actorId: 'merger',
  })
  assert.deepEqual(
    await db
      .prepare(
        `SELECT resource_key AS resourceKey, tag_id AS tagId,
              related_tag_id AS relatedTagId, released_at AS releasedAt
       FROM taxonomy_locks WHERE id = 'source-edge-lock'`,
      )
      .first(),
    { resourceKey: 'parent:3:2', tagId: 3, relatedTagId: 2, releasedAt: null },
  )
})
