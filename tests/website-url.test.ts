import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeWebsiteUrl, websiteUrlKey } from '../src/lib/website-url'

test('normalizes fragments, tracking parameters, query order, and trailing slash', () => {
  assert.equal(
    normalizeWebsiteUrl(
      'https://Example.com/path/?utm_source=x&b=2&a=1#section',
    ),
    'https://example.com/path?a=1&b=2',
  )
})

test('duplicate key treats http, https, and www as the same website', () => {
  assert.equal(
    websiteUrlKey('http://www.example.com/?fbclid=abc'),
    websiteUrlKey('https://example.com/#home'),
  )
})

test('duplicate key treats paths and tracking variants as one website', () => {
  assert.equal(
    websiteUrlKey('https://example.com/Case/Sensitive?utm_source=test'),
    websiteUrlKey('https://www.example.com/another/path?value=Different'),
  )
})

test('rejects non-http protocols', () => {
  assert.throws(() => normalizeWebsiteUrl('javascript:alert(1)'), /HTTP/)
})
