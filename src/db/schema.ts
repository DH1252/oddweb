import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const submissionsTable = sqliteTable(
  'submissions',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    url: text().notNull(),
    urlKey: text('url_key').notNull(),
    description: text().notNull(),
    tags: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    thumbnailKey: text('thumbnail_key'),
    thumbnailAlt: text('thumbnail_alt'),
    status: text()
      .$type<'pending' | 'approved' | 'rejected'>()
      .notNull()
      .default('pending'),
    submittedAt: integer('submitted_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('submissions_open_url_unique')
      .on(table.urlKey)
      .where(sql`${table.status} IN ('pending', 'approved')`),
    index('submissions_status_date_idx').on(table.status, table.submittedAt),
    check(
      'submissions_status_check',
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      'submissions_tags_json_check',
      sql`json_valid(${table.tags}) AND json_type(${table.tags}) = 'array'`,
    ),
    check(
      'submissions_reviewed_check',
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  ],
)

export const sitesTable = sqliteTable(
  'sites',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    slug: text().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    urlKey: text('url_key').notNull(),
    description: text().notNull(),
    summary: text().notNull().default(''),
    categories: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    poster: text().notNull().default('NEW FIND'),
    notes: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    facts: text({ mode: 'json' })
      .$type<Array<{ label: string; value: string }>>()
      .notNull()
      .default([]),
    accent: text().notNull().default('from-[#63396d] to-[#d27a3e]'),
    thumbnailKey: text('thumbnail_key'),
    thumbnailAlt: text('thumbnail_alt'),
    visits: integer().notNull().default(0),
    status: text().$type<'active' | 'archived'>().notNull().default('active'),
    source: text()
      .$type<'Directory' | 'Submission' | 'Manual'>()
      .notNull()
      .default('Manual'),
    submissionId: integer('submission_id').references(
      () => submissionsTable.id,
      { onDelete: 'set null' },
    ),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('sites_slug_unique').on(table.slug),
    uniqueIndex('sites_url_unique').on(table.url),
    uniqueIndex('sites_url_key_unique').on(table.urlKey),
    uniqueIndex('sites_submission_unique').on(table.submissionId),
    index('sites_status_added_idx').on(table.status, table.addedAt),
    check('sites_status_check', sql`${table.status} IN ('active', 'archived')`),
    check(
      'sites_source_check',
      sql`${table.source} IN ('Directory', 'Submission', 'Manual')`,
    ),
    check(
      'sites_submission_source_check',
      sql`(${table.source} = 'Submission') = (${table.submissionId} IS NOT NULL)`,
    ),
    check('sites_visits_nonnegative_check', sql`${table.visits} >= 0`),
    check(
      'sites_categories_json_check',
      sql`json_valid(${table.categories}) AND json_type(${table.categories}) = 'array'`,
    ),
    check(
      'sites_notes_json_check',
      sql`json_valid(${table.notes}) AND json_type(${table.notes}) = 'array'`,
    ),
    check(
      'sites_facts_json_check',
      sql`json_valid(${table.facts}) AND json_type(${table.facts}) = 'array'`,
    ),
  ],
)

export const tagsTable = sqliteTable(
  'tags',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    slug: text().notNull(),
    name: text().notNull(),
    category: text().notNull().default('Topic'),
    canonical: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('tags_slug_unique').on(table.slug),
    index('tags_canonical_category_idx').on(table.canonical, table.category),
  ],
)

export const tagAliasesTable = sqliteTable(
  'tag_aliases',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    alias: text().notNull(),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('tag_aliases_alias_unique').on(table.alias)],
)

export const tagParentsTable = sqliteTable(
  'tag_parents',
  {
    parentTagId: integer('parent_tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
    childTagId: integer('child_tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.parentTagId, table.childTagId] })],
)

export const siteTagsTable = sqliteTable(
  'site_tags',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sitesTable.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
    rawName: text('raw_name').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.siteId, table.rawName] }),
    index('site_tags_tag_idx').on(table.tagId),
  ],
)

export const guestbookTable = sqliteTable(
  'guestbook',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    message: text().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('guestbook_created_idx').on(table.createdAt),
    uniqueIndex('guestbook_entry_unique').on(table.name, table.message),
  ],
)

export const adminLoginAttemptsTable = sqliteTable('admin_login_attempts', {
  key: text().primaryKey(),
  failures: integer().notNull().default(0),
  windowStarted: integer('window_started', { mode: 'timestamp' }).notNull(),
  blockedUntil: integer('blocked_until', { mode: 'timestamp' }),
})

export const publicRateLimitsTable = sqliteTable('public_rate_limits', {
  key: text().primaryKey(),
  count: integer().notNull().default(0),
  windowStarted: integer('window_started', { mode: 'timestamp' }).notNull(),
})

export const appStateTable = sqliteTable('app_state', {
  key: text().primaryKey(),
  value: text().notNull(),
})

export const adminSessionsTable = sqliteTable(
  'admin_sessions',
  {
    id: text().primaryKey(),
    username: text().notNull(),
    credentialVersion: text('credential_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('admin_sessions_expires_idx').on(table.expiresAt),
    index('admin_sessions_username_idx').on(table.username),
    uniqueIndex('admin_sessions_one_live_username_unique')
      .on(table.username)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
)

export type SiteRow = typeof sitesTable.$inferSelect
export type SubmissionRow = typeof submissionsTable.$inferSelect
