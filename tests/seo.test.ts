import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SOCIAL_IMAGE,
  FALLBACK_SITE_ORIGIN,
  absoluteUrl,
  buildSitemapXml,
  canonicalOrigin,
  canonicalUrl,
  escapeXml,
  jsonLd,
  robotsText,
  resolveSiteOrigin,
  sitemapXml,
} from '../src/lib/seo'

test('public origin uses safe environment parsing and fallback', () => {
  assert.equal(resolveSiteOrigin('javascript:alert(1)'), FALLBACK_SITE_ORIGIN)
  assert.equal(
    resolveSiteOrigin('https://user:pass@example.com'),
    FALLBACK_SITE_ORIGIN,
  )
  assert.equal(
    resolveSiteOrigin('https://staging.example.com/path?q=1'),
    'https://staging.example.com',
  )
  assert.equal(
    absoluteUrl('/tags', 'https://staging.example.com'),
    'https://staging.example.com/tags',
  )
})

test('canonical URLs use the production origin and discard duplicate variants', () => {
  assert.equal(DEFAULT_SOCIAL_IMAGE, `${canonicalOrigin}/oddweb-social.png`)
  assert.equal(canonicalUrl('/'), `${canonicalOrigin}/`)
  assert.equal(
    canonicalUrl(
      'https://www.example.test/sites/radio-garden/?utm_source=x#top',
    ),
    `${canonicalOrigin}/sites/radio-garden`,
  )
})

test('robots and sitemap output escape and reference canonical URLs', () => {
  assert.equal(escapeXml(`a&<>'"`), 'a&amp;&lt;&gt;&apos;&quot;')
  assert.match(
    robotsText(),
    new RegExp(`Sitemap: ${canonicalOrigin}/sitemap\\.xml`),
  )
  const sitemap = sitemapXml(['/sites/a&b'])
  assert.match(sitemap, /<loc>https:\/\/oddweb\.page\/sites\/a&amp;b<\/loc>/)
  assert.doesNotMatch(sitemap, /<loc>[^<]*&b/)
})

test('structured data serializes as parseable JSON without literal tags', () => {
  const serialized = jsonLd({ '@type': 'WebSite', name: '</script><script>' })
  assert.deepEqual(JSON.parse(serialized), {
    '@type': 'WebSite',
    name: '</script><script>',
  })
  assert.doesNotMatch(serialized, /</)
})

test('dynamic sitemap includes supplied active sites, dates, and escaped URLs', () => {
  const sitemap = buildSitemapXml(
    [{ slug: 'active & odd', added: '2026-08-13' }],
    'https://staging.example.com',
  )
  assert.match(
    sitemap,
    /https:\/\/staging\.example\.com\/sites\/active%20%26%20odd/,
  )
  assert.match(sitemap, /<lastmod>2026-08-13<\/lastmod>/)
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  )
  assert.ok(locations.every((location) => !/admin|health|\?/.test(location)))
})
