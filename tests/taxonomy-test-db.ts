import { readFile, readdir } from 'node:fs/promises'

import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

type CleanupContext = {
  after: (cleanup: () => Promise<void> | void) => void
}

export async function migratedTaxonomyDb(context: CleanupContext) {
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
  const migrationsUrl = new URL('../drizzle/', import.meta.url)
  const migrations = (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()

  for (const migration of migrations) {
    const sql = await readFile(new URL(migration, migrationsUrl), 'utf8')
    await db.exec(
      sql
        .replaceAll('--> statement-breakpoint', '')
        .replace(/^--.*$/gm, '')
        .replace(/\s+/g, ' '),
    )
  }
  return db
}

export async function insertSite(
  db: D1Database,
  id: number,
  slug = `site-${id}`,
) {
  await db
    .prepare(
      `INSERT INTO sites
       (id, slug, name, url, url_key, description, status, source, content_version)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 'Manual', 1)`,
    )
    .bind(
      id,
      slug,
      `Site ${id}`,
      `https://${slug}.example/`,
      `${slug}.example`,
      `Description for ${slug}`,
    )
    .run()
}

export async function insertTag(
  db: D1Database,
  id: number,
  slug = `tag-${id}`,
  automationLocked = false,
) {
  await db
    .prepare(
      `INSERT INTO tags
       (id, slug, name, canonical, status, revision, automation_locked)
       VALUES (?, ?, ?, 1, 'active', 1, ?)`,
    )
    .bind(id, slug, `Tag ${id}`, automationLocked ? 1 : 0)
    .run()
}

export const masterKey = Buffer.from(new Uint8Array(32).fill(19)).toString(
  'base64url',
)
