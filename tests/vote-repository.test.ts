import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countSiteVotes,
  hasOtherActiveVoteOnSite,
  isSiteUnderVelocitySpike,
  readVisitorVotedSlugs,
  toggleSiteVote,
} from '../src/db/vote-repository'
import { migratedTaxonomyDb, insertSite } from './taxonomy-test-db'

test('votes toggle per visitor and aggregate per site', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1, 'alpha')
  await insertSite(db, 2, 'beta')

  const first = await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-a',
    requestId: '00000000-0000-4000-8000-000000000001',
    now: 100,
  })
  assert.deepEqual(first, {
    updated: true,
    voted: true,
    siteFound: true,
    votes: 1,
  })

  const duplicate = await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-a',
    requestId: '00000000-0000-4000-8000-000000000002',
    now: 100,
  })
  assert.deepEqual(duplicate, {
    updated: true,
    voted: false,
    siteFound: true,
    votes: 0,
  })

  const idempotentRetry = await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-a',
    requestId: '00000000-0000-4000-8000-000000000002',
    now: 100,
  })
  assert.deepEqual(idempotentRetry, {
    updated: false,
    voted: false,
    siteFound: true,
    votes: 0,
  })

  const second = await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-b',
    requestId: '00000000-0000-4000-8000-000000000003',
    now: 100,
  })
  assert.equal(second.voted, true)
  assert.equal(second.votes, 1)
  assert.equal(await countSiteVotes(db, 1), 1)

  await toggleSiteVote(db, {
    slug: 'beta',
    visitorKey: 'visitor-b',
    requestId: '00000000-0000-4000-8000-000000000004',
    now: 100,
  })
  assert.deepEqual(await readVisitorVotedSlugs(db, 'visitor-b'), [
    'beta',
    'alpha',
  ])
  assert.deepEqual(await readVisitorVotedSlugs(db, 'visitor-c'), [])
})

test('votes only apply to active sites', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1, 'active-site')
  await db.prepare(`UPDATE sites SET status = 'archived' WHERE id = 1`).run()
  const result = await toggleSiteVote(db, {
    slug: 'active-site',
    visitorKey: 'visitor',
  })
  assert.deepEqual(result, { updated: false, voted: false, siteFound: false })
  assert.equal(await countSiteVotes(db, 1), 0)
})

test('hasOtherActiveVoteOnSite detects other active votes on same IP', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1, 'alpha')

  // No active votes yet
  assert.equal(
    await hasOtherActiveVoteOnSite(db, 'alpha', 'cookie-v1:ip-1', 'visitor-a'),
    false,
  )

  // Visitor A votes on alpha with IP 1
  await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-a',
    identityScheme: 'cookie-v1:ip-1',
  })

  // Visitor A checking their own vote -> false (same visitor)
  assert.equal(
    await hasOtherActiveVoteOnSite(db, 'alpha', 'cookie-v1:ip-1', 'visitor-a'),
    false,
  )

  // Visitor B from same IP checking -> true (repeat IP vote!)
  assert.equal(
    await hasOtherActiveVoteOnSite(db, 'alpha', 'cookie-v1:ip-1', 'visitor-b'),
    true,
  )

  // Visitor B from different IP checking -> false (different IP)
  assert.equal(
    await hasOtherActiveVoteOnSite(db, 'alpha', 'cookie-v1:ip-2', 'visitor-b'),
    false,
  )

  // Visitor A unvotes
  await toggleSiteVote(db, {
    slug: 'alpha',
    visitorKey: 'visitor-a',
    identityScheme: 'cookie-v1:ip-1',
  })

  // Now no active vote from visitor-a -> false for visitor-b
  assert.equal(
    await hasOtherActiveVoteOnSite(db, 'alpha', 'cookie-v1:ip-1', 'visitor-b'),
    false,
  )
})

test('isSiteUnderVelocitySpike detects traffic surges', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1, 'viral-site')

  const now = 1000

  // 0 votes initially
  assert.equal(await isSiteUnderVelocitySpike(db, 'viral-site', now), false)

  // Simulate 19 votes within the 10-minute window
  for (let i = 1; i <= 19; i++) {
    await toggleSiteVote(db, {
      slug: 'viral-site',
      visitorKey: `legit-voter-${i}`,
      now,
    })
  }

  // 19 votes is below threshold of 20
  assert.equal(await isSiteUnderVelocitySpike(db, 'viral-site', now), false)

  // 20th vote arrives
  await toggleSiteVote(db, {
    slug: 'viral-site',
    visitorKey: 'legit-voter-20',
    now,
  })

  // 20 votes triggers isSiteUnderVelocitySpike -> true
  assert.equal(await isSiteUnderVelocitySpike(db, 'viral-site', now), true)

  // After 11 minutes (660s later), spike window expires -> false
  assert.equal(
    await isSiteUnderVelocitySpike(db, 'viral-site', now + 660),
    false,
  )
})
