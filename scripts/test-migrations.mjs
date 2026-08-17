import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const persist = mkdtempSync(join(tmpdir(), 'oddweb-d1-test-'))
const staged = join(persist, 'config')
const migrations = join(staged, 'drizzle')
const config = join(staged, 'wrangler.jsonc')

try {
  mkdirSync(migrations, { recursive: true })
  writeFileSync(
    config,
    JSON.stringify({
      name: 'oddweb-migration-test',
      compatibility_date: '2026-08-14',
      main: join(root, 'src/server.ts'),
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'oddweb',
          database_id: 'local-test',
          migrations_dir: 'drizzle',
        },
      ],
    }),
  )
  const migrationFiles = readdirSync(join(root, 'drizzle'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
  const taxonomyMigrationIndex = migrationFiles.findIndex((name) =>
    readFileSync(join(root, 'drizzle', name), 'utf8').includes(
      'CREATE TABLE `taxonomy_state`',
    ),
  )
  if (taxonomyMigrationIndex < 1)
    throw new Error('Could not locate the taxonomy migration boundary.')
  for (const name of migrationFiles.slice(0, taxonomyMigrationIndex)) {
    copyFileSync(join(root, 'drizzle', name), join(migrations, name))
  }
  run('npx', [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'oddweb',
    '--local',
    '--persist-to',
    persist,
    '--config',
    config,
  ])
  execute(`
    INSERT INTO submissions
      (id,name,url,url_key,description,tags,thumbnail_key,thumbnail_alt,status,reviewed_at)
    VALUES (41,'Preserved submission','https://preserved.example/','preserved.example',
            'Submission description','["Listen"]','submission.png','Submission alt','approved',1234);
    INSERT INTO sites
      (id,slug,name,url,url_key,description,summary,categories,poster,notes,facts,accent,
       thumbnail_key,thumbnail_alt,visits,status,source,submission_id,added_at,created_at)
    VALUES (51,'preserved','Preserved site','https://preserved.example/','preserved.example',
            'Site description','Site summary','["Legacy display group"]','POSTER',
            '["One note"]','[{"label":"Medium","value":"Audio"}]','from-a to-b',
            'site.png','Site alt',17,'active','Submission',41,111,222);
    INSERT INTO tags (id,slug,name,category,canonical,created_at)
    VALUES (61,'listen','Listen','Media',1,333), (62,'radio-copy','Radio copy','Media',0,334);
    INSERT INTO tag_aliases (id,alias,tag_id) VALUES (71,'radio',61);
    INSERT INTO tag_parents (parent_tag_id,child_tag_id) VALUES (61,62);
    INSERT INTO site_tags (site_id,tag_id,raw_name) VALUES
      (51,61,'Listen'), (51,61,'Radio'), (51,62,'Radio copy');
  `)
  for (const name of migrationFiles.slice(taxonomyMigrationIndex)) {
    copyFileSync(join(root, 'drizzle', name), join(migrations, name))
  }
  run('npx', [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'oddweb',
    '--local',
    '--persist-to',
    persist,
    '--config',
    config,
  ])
  const preserved = query(`
    SELECT s.id, s.slug, s.name, s.summary, s.categories, s.poster, s.notes, s.facts,
           s.accent, s.thumbnail_key AS thumbnailKey, s.thumbnail_alt AS thumbnailAlt,
           s.visits, s.status, s.source, s.submission_id AS submissionId,
           s.added_at AS addedAt, s.created_at AS createdAt, s.content_version AS contentVersion,
           submission.status AS submissionStatus
    FROM sites s JOIN submissions submission ON submission.id = s.submission_id WHERE s.id = 51;
  `)[0]
  assert.deepEqual(preserved, {
    id: 51,
    slug: 'preserved',
    name: 'Preserved site',
    summary: 'Site summary',
    categories: '["Legacy display group"]',
    poster: 'POSTER',
    notes: '["One note"]',
    facts: '[{"label":"Medium","value":"Audio"}]',
    accent: 'from-a to-b',
    thumbnailKey: 'site.png',
    thumbnailAlt: 'Site alt',
    visits: 17,
    status: 'active',
    source: 'Submission',
    submissionId: 41,
    addedAt: 111,
    createdAt: 222,
    contentVersion: 1,
    submissionStatus: 'approved',
  })
  assert.deepEqual(
    query(`SELECT id,slug,name,canonical,status,revision,automation_locked AS automationLocked,
                  created_at AS createdAt,updated_at AS updatedAt FROM tags ORDER BY id`),
    [
      {
        id: 61,
        slug: 'listen',
        name: 'Listen',
        canonical: 1,
        status: 'active',
        revision: 1,
        automationLocked: 0,
        createdAt: 333,
        updatedAt: 333,
      },
      {
        id: 62,
        slug: 'radio-copy',
        name: 'Radio copy',
        canonical: 0,
        status: 'active',
        revision: 1,
        automationLocked: 0,
        createdAt: 334,
        updatedAt: 334,
      },
    ],
  )
  assert.equal(
    query(
      "SELECT count(*) AS count FROM pragma_table_info('tags') WHERE name = 'category'",
    )[0].count,
    0,
  )
  assert.equal(
    query(
      "SELECT count(*) AS count FROM sqlite_schema WHERE lower(sql) LIKE '%taxonomy%category%'",
    )[0].count,
    0,
  )
  assert.equal(
    query('SELECT count(*) AS count FROM pragma_foreign_key_check')[0].count,
    0,
  )
  assert.deepEqual(
    query(
      'SELECT published_version AS version,mode,circuit_state AS circuit FROM taxonomy_state',
    ),
    [{ version: 1, mode: 'disabled', circuit: 'closed' }],
  )
  assert.deepEqual(
    query(`SELECT site_id AS siteId,tag_id AS tagId,raw_name AS rawName,source,revision
           FROM site_tags ORDER BY tag_id`),
    [
      {
        siteId: 51,
        tagId: 61,
        rawName: 'Listen',
        source: 'migration',
        revision: 1,
      },
      {
        siteId: 51,
        tagId: 62,
        rawName: 'Radio copy',
        source: 'migration',
        revision: 1,
      },
    ],
    'taxonomy migration must preserve and deduplicate existing site-tag assignments',
  )
  assert.deepEqual(query('SELECT alias,tag_id AS tagId FROM tag_aliases'), [
    { alias: 'radio', tagId: 61 },
  ])
  assert.deepEqual(
    query(
      'SELECT parent_tag_id AS parentId,child_tag_id AS childId FROM tag_parents',
    ),
    [{ parentId: 61, childId: 62 }],
  )
  const output = exec('npx', [
    'wrangler',
    'd1',
    'execute',
    'oddweb',
    '--local',
    '--persist-to',
    persist,
    '--command',
    `INSERT INTO submissions (name,url,url_key,description,tags,thumbnail_key,thumbnail_alt,status,reviewed_at)
     VALUES ('Test','https://example.test/','example.test','Test','[]','test.png','Test','approved',unixepoch());
     INSERT INTO sites (slug,name,url,url_key,description,status,source,submission_id)
     SELECT 'test','Test','https://example.test/','example.test','Test','active','Submission',id
     FROM submissions WHERE url_key='example.test';
     SELECT COUNT(*) AS valid_link FROM sites JOIN submissions ON submissions.id=sites.submission_id
     WHERE sites.url_key='example.test' AND sites.status='active' AND submissions.status='approved';`,
    '--json',
    '--config',
    config,
  ])
  const result = JSON.parse(output)
  const validLink = result.at(-1)?.results?.[0]?.valid_link
  if (validLink !== 1)
    throw new Error('approved submission/site invariant failed')

  expectFailure(
    `INSERT INTO sites (slug,name,url,url_key,description,status,source,submission_id)
     VALUES ('invalid','Invalid','https://invalid.test/','invalid.test','Invalid','active','Submission',999)`,
  )
  expectFailure(
    `INSERT INTO submissions (name,url,url_key,description,tags,status,reviewed_at)
     VALUES ('Bad','https://bad.test/','bad.test','Bad','not-json','pending',NULL)`,
  )
  expectFailure(
    `INSERT INTO submissions (name,url,url_key,description,tags,status,reviewed_at)
     VALUES ('Bad values','https://bad-values.test/','bad-values.test','Bad','[null,1]','pending',NULL)`,
  )
  expectFailure("INSERT INTO tags (slug,name,canonical) VALUES ('','Bad',0)")
  expectFailure(
    'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (1, 1)',
  )
  expectFailure(
    `INSERT INTO submissions (name,url,url_key,description,tags,status,reviewed_at)
     VALUES ('Conflict','https://elsewhere.test/','elsewhere.test','Conflict','[]','rejected',unixepoch());
     UPDATE submissions SET url_key='example.test', status='pending', reviewed_at=NULL WHERE name='Conflict'`,
  )
  expectFailure(
    `INSERT INTO tags (slug,name,canonical) VALUES ('parent-a','Parent A',1);
     INSERT INTO tags (slug,name,canonical) VALUES ('parent-b','Parent B',1);
     INSERT INTO tags (slug,name,canonical) VALUES ('parent-c','Parent C',1);
     INSERT INTO tag_parents (parent_tag_id,child_tag_id)
       SELECT a.id,b.id FROM tags a,tags b WHERE a.slug='parent-a' AND b.slug='parent-b';
     INSERT INTO tag_parents (parent_tag_id,child_tag_id)
       SELECT c.id,a.id FROM tags c,tags a WHERE c.slug='parent-c' AND a.slug='parent-a';
     UPDATE tag_parents SET parent_tag_id=(SELECT id FROM tags WHERE slug='parent-b')
       WHERE parent_tag_id=(SELECT id FROM tags WHERE slug='parent-c') AND child_tag_id=(SELECT id FROM tags WHERE slug='parent-a')`,
  )
  console.log('Migration and database invariant tests passed.')
} finally {
  rmSync(persist, { recursive: true, force: true })
}

function expectFailure(sql) {
  try {
    execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'oddweb',
        '--local',
        '--persist-to',
        persist,
        '--config',
        config,
        '--command',
        sql,
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    )
  } catch {
    return
  }
  throw new Error(`Expected D1 statement to fail: ${sql}`)
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function exec(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function execute(sql) {
  return exec('npx', [
    'wrangler',
    'd1',
    'execute',
    'oddweb',
    '--local',
    '--persist-to',
    persist,
    '--command',
    sql,
    '--config',
    config,
  ])
}

function query(sql) {
  const result = JSON.parse(
    exec('npx', [
      'wrangler',
      'd1',
      'execute',
      'oddweb',
      '--local',
      '--persist-to',
      persist,
      '--command',
      sql,
      '--json',
      '--config',
      config,
    ]),
  )
  return result.at(-1)?.results ?? []
}
