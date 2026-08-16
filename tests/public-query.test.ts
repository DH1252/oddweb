import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  buildPublicSiteFilter,
  d1ExactAndFuzzySearch,
  d1LikePattern,
  d1LikePatternMaxBytes,
  publicTagClosureCte,
} from '../src/db/public-query'

test('public LIKE patterns never truncate semantic input', () => {
  const patterns = [d1LikePattern('safe'), d1LikePattern('💩'.repeat(12))]

  for (const pattern of patterns) {
    assert.notEqual(pattern, null)
    assert.ok(
      new TextEncoder().encode(pattern || '').byteLength <=
        d1LikePatternMaxBytes,
    )
  }
  assert.equal(d1LikePattern('x'.repeat(120)), null)
  assert.equal(d1LikePattern('💩'.repeat(80)), null)
  assert.equal(d1LikePattern('%'.repeat(80)), null)
  assert.equal(d1LikePattern('   '), '')
})

test('over-limit public searches use exact input without prefix matches', (t) => {
  const db = createFilterDatabase()
  t.after(() => db.close())
  const prefix = 'x'.repeat(48)
  const query = `${prefix}different suffix`
  db.prepare('INSERT INTO sites VALUES (1, ?, ?, NULL, ?, ?)').run(
    'active',
    'Seed',
    prefix,
    'Directory entry',
  )
  db.prepare('INSERT INTO sites VALUES (2, ?, ?, NULL, ?, ?)').run(
    'active',
    'Seed',
    query,
    'Exact directory entry',
  )

  const filter = buildPublicSiteFilter({
    query,
    include: [],
    exclude: [],
  })
  const row = db
    .prepare(
      `${publicTagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${filter.sql}`,
    )
    .get(...filter.bindings) as { total: number }

  assert.equal(row.total, 1)
  assert.deepEqual(filter.bindings, Array<string>(6).fill(query))
})

test('long tag searches preserve exact input and omit unsafe fuzzy input', () => {
  const query = `${'x'.repeat(48)} semantically distinct suffix`
  assert.deepEqual(d1ExactAndFuzzySearch(query), {
    exact: query,
    fuzzy: '',
  })
})

test('maximum public filters use bounded JSON parameters and execute', (t) => {
  const db = createFilterDatabase()
  t.after(() => db.close())
  db.exec(
    `INSERT INTO sites VALUES (1, 'active', 'Seed', NULL, 'Needle', 'Directory entry')`,
  )
  const insertTag = db.prepare(
    'INSERT INTO tags (id, slug, name, canonical) VALUES (?, ?, ?, 1)',
  )
  const assignTag = db.prepare(
    'INSERT INTO site_tags (site_id, tag_id, raw_name) VALUES (1, ?, ?)',
  )
  for (let id = 1; id <= 40; id += 1) {
    const slug = `tag-${id}`
    insertTag.run(id, slug, slug)
    if (id <= 20) assignTag.run(id, slug)
  }

  const include = Array.from({ length: 20 }, (_, index) => `tag-${index + 1}`)
  const exclude = Array.from({ length: 20 }, (_, index) => `tag-${index + 21}`)
  const filter = buildPublicSiteFilter({ query: '', include, exclude })
  const row = db
    .prepare(
      `${publicTagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${filter.sql}`,
    )
    .get(...filter.bindings) as { total: number }

  assert.equal(row.total, 1)
  assert.equal(filter.bindings.length, 2)
  assert.deepEqual(JSON.parse(filter.bindings[0]), include)
  assert.deepEqual(JSON.parse(filter.bindings[1]), exclude)

  const maximumSearch = buildPublicSiteFilter({
    query: '%'.repeat(120),
    include,
    exclude,
  })
  assert.equal(maximumSearch.bindings.length + 2, 10)
  assert.ok(maximumSearch.bindings.length + 2 < 100)
  assert.doesNotThrow(() =>
    db
      .prepare(
        `${publicTagClosureCte} SELECT s.id FROM sites s WHERE ${maximumSearch.sql} LIMIT ? OFFSET ?`,
      )
      .all(...maximumSearch.bindings, 6, 0),
  )
})

test('JSON filters preserve aliases, descendants, and freeform matching', (t) => {
  const db = createFilterDatabase()
  t.after(() => db.close())
  db.exec(`
    INSERT INTO sites VALUES (1, 'active', 'Seed', NULL, 'Rain toy', 'Entry');
    INSERT INTO tags VALUES (1, 'listen', 'Listen', 1);
    INSERT INTO tags VALUES (2, 'rain', 'Rain', 1);
    INSERT INTO tags VALUES (3, 'browser-toy', 'Browser Toy', 0);
    INSERT INTO tag_aliases VALUES (1, 'audio');
    INSERT INTO tag_parents VALUES (1, 2);
    INSERT INTO site_tags VALUES (1, 2, 'rain');
    INSERT INTO site_tags VALUES (1, 3, 'Browser  \t Toy\n');
  `)

  const included = buildPublicSiteFilter({
    query: '',
    include: ['audio', '~browser toy'],
    exclude: [],
  })
  const includedRow = db
    .prepare(
      `${publicTagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${included.sql}`,
    )
    .get(...included.bindings) as { total: number }
  assert.equal(includedRow.total, 1)

  const excluded = buildPublicSiteFilter({
    query: '',
    include: [],
    exclude: ['listen'],
  })
  const excludedRow = db
    .prepare(
      `${publicTagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${excluded.sql}`,
    )
    .get(...excluded.bindings) as { total: number }
  assert.equal(excludedRow.total, 0)
})

function createFilterDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE sites (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      submission_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      canonical INTEGER NOT NULL
    );
    CREATE TABLE tag_aliases (tag_id INTEGER NOT NULL, alias TEXT NOT NULL);
    CREATE TABLE tag_parents (
      parent_tag_id INTEGER NOT NULL,
      child_tag_id INTEGER NOT NULL
    );
    CREATE TABLE site_tags (
      site_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      raw_name TEXT NOT NULL
    );
  `)
  return db
}
