import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeFilterTagList,
  resolveFilterTagList,
  publicFilterTagLimit,
  tagInputMaxLength,
  tagTokensFromNames,
  tagsMatchFilter,
  tagSlug,
} from '../src/data/tags'

import type { CanonicalTag } from '../src/data/tags'

const catalog: CanonicalTag[] = [
  {
    slug: 'listen',
    name: 'Listen',
    aliases: ['audio'],
    parents: [],
    count: 1,
  },
  {
    slug: 'rain',
    name: 'Rain',
    aliases: [],
    parents: ['listen'],
    count: 1,
  },
]

test('freeform tags round-trip and match exactly', () => {
  assert.deepEqual(tagTokensFromNames(['~browser toy'], catalog), [
    '~browser toy',
  ])
  assert.equal(tagsMatchFilter(['~browser toy'], '~browser toy', catalog), true)
  assert.equal(tagsMatchFilter(['~different'], '~browser toy', catalog), false)
})

test('aliases resolve to their canonical tag', () => {
  assert.deepEqual(resolveFilterTagList(['audio'], catalog), ['listen'])
})

test('subtags inherit parent filters', () => {
  assert.equal(tagsMatchFilter(['rain'], 'listen', catalog), true)
})

test('punctuation-only freeform tags have no valid slug', () => {
  assert.equal(tagSlug('~~~ !!!'), '')
})

test('public filter tags normalize within shared count and length limits', () => {
  const values = [
    `~${'x'.repeat(tagInputMaxLength)}`,
    'x'.repeat(tagInputMaxLength + 1),
    ...Array.from(
      { length: publicFilterTagLimit + 5 },
      (_, index) => ` Tag ${index} `,
    ),
  ]

  const normalized = normalizeFilterTagList(values)
  assert.equal(normalized.length, publicFilterTagLimit)
  assert.equal(normalized[0], `~${'x'.repeat(tagInputMaxLength)}`)
  assert.equal(normalized.includes('x'.repeat(tagInputMaxLength + 1)), false)
})
