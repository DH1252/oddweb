export type ToggleSiteVoteInput = {
  slug: string
  visitorKey: string
  requestId?: string
  identityScheme?: string
  now?: number
}

export type ToggleSiteVoteResult = {
  updated: boolean
  voted: boolean
  siteFound: boolean
  votes?: number
}

export class VoteRepositoryError extends Error {
  readonly code = 'SITE_VOTE_DATABASE_ERROR'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VoteRepositoryError'
  }
}

export async function toggleSiteVote(
  database: D1Database,
  input: ToggleSiteVoteInput,
): Promise<ToggleSiteVoteResult> {
  const requestId = input.requestId ?? crypto.randomUUID()
  const site = await database
    .prepare(
      `SELECT id FROM sites WHERE slug = ?1 AND status = 'active' LIMIT 1`,
    )
    .bind(input.slug)
    .first<{ id: number }>()
  if (!site) return { updated: false, voted: false, siteFound: false }

  const now = input.now ?? Math.floor(Date.now() / 1000)
  const existingAction = await database
    .prepare(
      `SELECT status, voted, votes FROM vote_toggle_actions
       WHERE request_id = ?1 AND site_id = ?2 AND visitor_key = ?3`,
    )
    .bind(requestId, site.id, input.visitorKey)
    .first<{ status: string; voted: number | null; votes: number | null }>()
  if (existingAction?.status === 'complete' && existingAction.voted !== null) {
    return {
      updated: false,
      voted: existingAction.voted === 1,
      siteFound: true,
      votes: existingAction.votes ?? 0,
    }
  }
  if (existingAction) {
    throw new VoteRepositoryError('That vote is still being processed.')
  }

  const claimed = await database
    .prepare(
      `INSERT OR IGNORE INTO vote_toggle_actions
       (request_id, site_id, visitor_key, status, created_at)
       VALUES (?1, ?2, ?3, 'pending', ?4)
       RETURNING request_id`,
    )
    .bind(requestId, site.id, input.visitorKey, now)
    .first<{ request_id: string }>()
  if (!claimed) {
    throw new VoteRepositoryError('That vote is still being processed.')
  }

  try {
    const identityScheme = input.identityScheme ?? 'cookie-v1'
    const result = await database.batch([
      database
        .prepare(
          `INSERT INTO site_votes
             (site_id, visitor_key, identity_scheme, voted, quarantined, created_at, updated_at)
           VALUES (?1, ?2, ?3, 1, 0, ?4, ?4)
           ON CONFLICT(site_id, visitor_key) DO UPDATE SET
             voted = CASE WHEN site_votes.voted = 1 THEN 0 ELSE 1 END,
             identity_scheme = excluded.identity_scheme,
             updated_at = excluded.updated_at`,
        )
        .bind(site.id, input.visitorKey, identityScheme, now),
      database
        .prepare(
          `UPDATE vote_toggle_actions
           SET status = 'complete', voted = (
                 SELECT voted FROM site_votes
                 WHERE site_id = ?2 AND visitor_key = ?3
               ), votes = (
                 SELECT count(*) FROM site_votes
                 WHERE site_id = ?2 AND voted = 1 AND quarantined = 0
               )
           WHERE request_id = ?1`,
        )
        .bind(requestId, site.id, input.visitorKey),
    ])
    if (result[1].meta.changes !== 1) {
      throw new VoteRepositoryError('Vote state could not be recorded.')
    }
    const completed = await database
      .prepare(
        'SELECT voted, votes FROM vote_toggle_actions WHERE request_id = ?1',
      )
      .bind(requestId)
      .first<{ voted: number; votes: number }>()
    if (!completed)
      throw new VoteRepositoryError('Vote state could not be read.')
    return {
      updated: result[0].meta.changes > 0,
      voted: completed.voted === 1,
      siteFound: true,
      votes: completed.votes,
    }
  } catch (error) {
    await database
      .prepare(
        'DELETE FROM vote_toggle_actions WHERE request_id = ?1 AND status = ?2',
      )
      .bind(requestId, 'pending')
      .run()
    if (error instanceof VoteRepositoryError) throw error
    throw new VoteRepositoryError('Vote state could not be recorded.', {
      cause: error,
    })
  }
}

export async function countSiteVotes(database: D1Database, siteId: number) {
  const row = await database
    .prepare(
      `SELECT count(*) AS total FROM site_votes
       WHERE site_id = ?1 AND voted = 1 AND quarantined = 0`,
    )
    .bind(siteId)
    .first<{ total: number }>()
  return row?.total || 0
}

export async function hasOtherActiveVoteOnSite(
  database: D1Database,
  siteSlug: string,
  identityScheme: string,
  currentVisitorKey: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 FROM site_votes v
       JOIN sites s ON s.id = v.site_id
       WHERE s.slug = ?1
         AND v.identity_scheme = ?2
         AND v.visitor_key <> ?3
         AND v.voted = 1
         AND v.quarantined = 0
       LIMIT 1`,
    )
    .bind(siteSlug, identityScheme, currentVisitorKey)
    .first()
  return Boolean(row)
}

export async function isSiteUnderVelocitySpike(
  database: D1Database,
  siteSlug: string,
  now = Math.floor(Date.now() / 1000),
  threshold = 20,
  windowSeconds = 600,
): Promise<boolean> {
  const cutoff = now - windowSeconds
  const row = await database
    .prepare(
      `SELECT count(*) AS recent FROM site_votes v
       JOIN sites s ON s.id = v.site_id
       WHERE s.slug = ?1 AND v.voted = 1 AND v.updated_at >= ?2`,
    )
    .bind(siteSlug, cutoff)
    .first<{ recent: number }>()
  return (row?.recent ?? 0) >= threshold
}

export async function readVisitorVotedSlugs(
  database: D1Database,
  visitorKey: string,
): Promise<string[]> {
  const rows = await database
    .prepare(
      `SELECT site.slug FROM site_votes vote
       JOIN sites site ON site.id = vote.site_id AND site.status = 'active'
       WHERE vote.visitor_key = ?1
         AND vote.identity_scheme LIKE 'cookie-v1%'
         AND vote.voted = 1
         AND vote.quarantined = 0
       ORDER BY vote.updated_at DESC, vote.id DESC`,
    )
    .bind(visitorKey)
    .all<{ slug: string }>()
  return rows.results.map((row) => row.slug)
}
