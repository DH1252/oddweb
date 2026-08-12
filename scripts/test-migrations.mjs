import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const persist = mkdtempSync(join(tmpdir(), 'oddweb-d1-test-'))

try {
  run('npx', [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'oddweb',
    '--local',
    '--persist-to',
    persist,
  ])
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
     VALUES ('test','Test','https://example.test/','example.test','Test','active','Submission',1);
     SELECT COUNT(*) AS valid_link FROM sites JOIN submissions ON submissions.id=sites.submission_id
     WHERE sites.status='active' AND submissions.status='approved';`,
    '--json',
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
  expectFailure(
    "INSERT INTO tags (slug,name,category,canonical) VALUES ('','Bad','Topic',0)",
  )
  expectFailure(
    'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (1, 1)',
  )
  expectFailure(
    `INSERT INTO submissions (name,url,url_key,description,tags,status,reviewed_at)
     VALUES ('Conflict','https://elsewhere.test/','elsewhere.test','Conflict','[]','rejected',unixepoch());
     UPDATE submissions SET url_key='example.test', status='pending', reviewed_at=NULL WHERE name='Conflict'`,
  )
  expectFailure(
    `INSERT INTO tags (slug,name,category,canonical) VALUES ('parent-a','Parent A','Topic',1);
     INSERT INTO tags (slug,name,category,canonical) VALUES ('parent-b','Parent B','Topic',1);
     INSERT INTO tags (slug,name,category,canonical) VALUES ('parent-c','Parent C','Topic',1);
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
