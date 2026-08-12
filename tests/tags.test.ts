import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveFilterTagList,
  tagTokensFromNames,
  tagsMatchFilter,
  tagSlug,
} from '../src/data/tags'

import type { CanonicalTag } from '../src/data/tags'

const catalog: CanonicalTag[] = [
  {
    slug: 'listen',
    name: 'Listen',
    category: 'Activity',
    aliases: ['audio'],
    parents: [],
    count: 1,
  },
  {
    slug: 'rain',
    name: 'Rain',
    category: 'Topic',
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
