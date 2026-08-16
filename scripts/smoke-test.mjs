import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { readJsonc, taxonomyResources } from './check-taxonomy-resources.mjs'

const staging = process.argv.includes('--staging')
const local = process.argv.includes('--local')
const applicationOnly = process.argv.includes('--application-only')
const triggersOnly = process.argv.includes('--triggers-only')
const readOnlyTriggers = process.argv.includes('--read-only-triggers')
const production = !staging && !local
const productionOrigin = 'https://oddweb.page'
const baseUrl =
  process.env[
    local ? 'LOCAL_URL' : staging ? 'STAGING_URL' : 'PRODUCTION_URL'
  ] ?? (local ? 'http://localhost:3000' : staging ? '' : productionOrigin)
const expectedRelease = process.env.RELEASE_SHA
const queueInitiallyPaused =
  process.env.RELEASE_TAXONOMY_QUEUE_INITIAL_STATE === 'paused'
const configPath = resolve(
  process.env.WRANGLER_CONFIG ??
    (staging ? '.wrangler/staging.jsonc' : 'wrangler.jsonc'),
)

if (applicationOnly && triggersOnly) {
  throw new Error(
    '--application-only and --triggers-only are mutually exclusive.',
  )
}
if (local && triggersOnly) {
  throw new Error(
    '--triggers-only requires an authenticated remote environment.',
  )
}
if (readOnlyTriggers && !triggersOnly) {
  throw new Error('--read-only-triggers requires --triggers-only.')
}

if (!baseUrl || !URL.canParse(baseUrl)) {
  throw new Error('The smoke-test URL must be an absolute URL.')
}
const target = new URL(baseUrl)
if (target.protocol !== 'https:' && !(local && isLoopback(target.hostname))) {
  throw new Error(
    'Smoke-test URLs must use HTTPS except for local loopback targets.',
  )
}
const expectedOrigin = staging ? target.origin : productionOrigin
if (production && target.origin !== productionOrigin) {
  throw new Error(
    `PRODUCTION_URL must use the canonical origin ${productionOrigin}.`,
  )
}

if (triggersOnly) await retry(healthProbe)

if (!triggersOnly) {
  await retry(async () => {
    await healthProbe()

    const robots = await request('/robots.txt')
    expectStatus(robots, 200, '/robots.txt')
    expectContentType(robots, 'text/plain', '/robots.txt')
    const robotsBody = await robots.text()
    expectMatch(robotsBody, /^User-agent: \*$/m, 'robots user agent')
    if (staging) {
      expectMatch(robotsBody, /^Disallow: \/$/m, 'staging robots block')
    } else {
      expectMatch(robotsBody, /^Disallow: \/admin$/m, 'robots admin rule')
      expectMatch(
        robotsBody,
        new RegExp(
          `^Sitemap: ${escapeRegex(expectedOrigin)}/sitemap\\.xml$`,
          'm',
        ),
        'robots canonical sitemap',
      )
    }

    const sitemap = await request('/sitemap.xml')
    expectStatus(sitemap, 200, '/sitemap.xml')
    expectContentType(sitemap, 'application/xml', '/sitemap.xml')
    const sitemapBody = await sitemap.text()
    expectMatch(
      sitemapBody,
      /^<\?xml version="1\.0" encoding="UTF-8"\?>/,
      'sitemap XML declaration',
    )
    expectMatch(
      sitemapBody,
      /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
      'sitemap root',
    )
    expectMatch(
      sitemapBody,
      new RegExp(`<loc>${escapeRegex(expectedOrigin)}/</loc>`),
      'sitemap homepage',
    )
    expectMatch(
      sitemapBody,
      new RegExp(
        `<loc>${escapeRegex(expectedOrigin)}/sites/radio-garden</loc>`,
      ),
      'sitemap detail',
    )
    if (/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(sitemapBody)) {
      throw new Error('sitemap contains an unescaped XML entity')
    }
    const sitemapLocations = [
      ...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g),
    ].map((match) => decodeHtml(match[1]))
    if (
      sitemapLocations.some((location) => {
        const url = new URL(location)
        return url.origin !== expectedOrigin || url.search || url.hash
      })
    ) {
      throw new Error('sitemap contains a noncanonical URL')
    }

    const home = await html('/')
    expectCanonical(home.body, `${expectedOrigin}/`, 'homepage')
    expectMeta(
      home.body,
      'property',
      'og:url',
      `${expectedOrigin}/`,
      'homepage',
    )
    if (staging)
      expectMeta(home.body, 'name', 'robots', 'noindex, nofollow', 'homepage')
    expectMetaPresent(home.body, 'property', 'og:title', 'homepage')
    const website = findJsonLd(home.body, 'WebSite')
    if (website.url !== `${expectedOrigin}/` || website.name !== 'Oddweb') {
      throw new Error('homepage WebSite JSON-LD has unexpected identity fields')
    }

    const detail = await html('/sites/radio-garden')
    expectCanonical(
      detail.body,
      `${expectedOrigin}/sites/radio-garden`,
      'detail page',
    )
    expectMetaPresent(detail.body, 'name', 'description', 'detail page')
    expectMeta(
      detail.body,
      'property',
      'og:url',
      `${expectedOrigin}/sites/radio-garden`,
      'detail page',
    )
    findJsonLd(detail.body, 'WebPage')

    const missing = await request('/sites/not-a-real-site', {
      redirect: 'manual',
    })
    expectStatus(missing, 404, 'unknown site')
    const missingBody = await missing.text()
    expectMeta(
      missingBody,
      'name',
      'robots',
      'noindex, nofollow',
      'unknown site',
    )
    if (!missing.headers.get('cache-control')?.includes('no-store')) {
      throw new Error('unknown site was not marked no-store')
    }
    if (
      missing.headers.get('x-robots-tag') &&
      !missing.headers.get('x-robots-tag')?.includes('noindex')
    ) {
      throw new Error('unknown site returned an invalid X-Robots-Tag')
    }

    const filtered = await html('/?include=listen')
    expectCanonical(filtered.body, `${expectedOrigin}/`, 'filtered homepage')
    expectMeta(
      filtered.body,
      'name',
      'robots',
      'noindex, follow',
      'filtered homepage',
    )

    const admin = await request('/admin', { redirect: 'manual' })
    if (![302, 307].includes(admin.status)) {
      throw new Error(`anonymous /admin returned ${admin.status}`)
    }
    if (!(admin.headers.get('location') || '').includes('/admin/login')) {
      throw new Error('anonymous /admin did not redirect to login')
    }
    const login = await html('/admin/login')
    expectNoindex(login.response, '/admin/login')
    if (!login.response.headers.get('cache-control')?.includes('no-store')) {
      throw new Error('/admin/login was not marked no-store')
    }
    expectMeta(
      login.body,
      'name',
      'robots',
      'noindex, nofollow',
      '/admin/login',
    )
  })
}

if (production) {
  await checkDuplicateOrigin(
    process.env.WWW_URL || 'https://www.oddweb.page',
    'redirect',
    { optionalDns: !process.env.WWW_URL },
  )
  await checkDuplicateOrigin(
    process.env.WORKERS_DEV_URL || 'https://oddweb.oddweb.workers.dev',
    'disabled',
  )
}

if (!local && !applicationOnly && !readOnlyTriggers) {
  await taxonomyProbe()
} else if (readOnlyTriggers) {
  await taxonomyReadOnlyProbe()
  console.warn(
    'Queue delivery remains externally paused; trigger verification is read-only and the release remains incomplete.',
  )
}
if (!triggersOnly) await realtimeProbe()

console.log(`Smoke test passed for ${baseUrl}.`)

async function taxonomyProbe() {
  const config = readJsonc(configPath)
  const { database, worker } = taxonomyResources(config)
  if (!database || !worker) {
    throw new Error('Taxonomy smoke requires a Worker name and DB binding.')
  }
  try {
    wrangler(['whoami'])
  } catch {
    throw new Error(
      'Cloudflare authentication is unavailable; authenticated taxonomy smoke cannot run.',
    )
  }

  const suffix = randomUUID().replaceAll('-', '')
  const jobId = `smoke:${suffix}`
  const batchId = `smoke-batch:${suffix}`
  const eventId = `smoke-event:${suffix}`
  const now = Math.floor(Date.now() / 1_000)
  const zeroHash = '0'.repeat(64)
  const state = queryD1(
    database,
    'SELECT published_version, mode, circuit_state FROM taxonomy_state WHERE id = 1',
  )[0]
  if (
    !state ||
    !Number.isInteger(Number(state.published_version)) ||
    !['disabled', 'shadow', 'gradual', 'autonomous', 'degraded'].includes(
      state.mode,
    )
  ) {
    throw new Error('taxonomy_state is missing or unreadable')
  }
  const insert = `
INSERT INTO taxonomy_jobs
  (id, job_key, kind, site_id, input_hash, site_content_version,
   taxonomy_version, status, priority, max_attempts, available_at, created_at, updated_at)
SELECT '${jobId}', '${jobId}', 'classify_site', id, '${zeroHash}', content_version + 1,
       (SELECT published_version FROM taxonomy_state WHERE id = 1),
       'pending', 1000, 1, ${now}, ${now}, ${now}
FROM sites WHERE status = 'active' ORDER BY id LIMIT 1;
INSERT INTO taxonomy_outbox (id, job_id, payload, available_at, created_at)
SELECT 'outbox:${jobId}', id, json_object('jobId', id), ${now}, ${now}
FROM taxonomy_jobs WHERE id = '${jobId}';`

  try {
    executeD1(database, insert)
    const inserted = queryD1(
      database,
      `SELECT count(*) AS count FROM taxonomy_jobs WHERE id = '${jobId}'`,
    )[0]
    if (Number(inserted?.count) !== 1) {
      throw new Error(
        'taxonomy smoke could not create its no-op shadow probe job',
      )
    }

    let result
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = queryD1(
        database,
        `SELECT j.status, j.attempt_count, j.last_error_code,
                o.dispatch_attempts, o.dispatched_at
         FROM taxonomy_jobs j JOIN taxonomy_outbox o ON o.job_id = j.id
         WHERE j.id = '${jobId}'`,
      )
      result = rows[0]
      if (
        result &&
        ['obsolete', 'degraded'].includes(result.status) &&
        Number(result.attempt_count) === 1 &&
        Number(result.dispatch_attempts) >= 1 &&
        result.dispatched_at
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
    if (
      !result ||
      !['obsolete', 'degraded'].includes(result.status) ||
      Number(result.attempt_count) !== 1 ||
      Number(result.dispatch_attempts) < 1 ||
      !result.dispatched_at
    ) {
      throw new Error(
        `taxonomy cron/queue/outbox probe did not settle safely: ${JSON.stringify(result ?? null)}`,
      )
    }

    const auditTime = Math.floor(Date.now() / 1_000)
    executeD1(
      database,
      `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, created_at, applied_at, completed_at)
       SELECT '${batchId}', 'classification', 'applied', 'system', 'release-smoke',
              published_version, published_version,
              'Authenticated no-op taxonomy release probe', ${auditTime}, ${auditTime}, ${auditTime}
       FROM taxonomy_state WHERE id = 1;
       INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          actor_id, taxonomy_version_before, taxonomy_version_after, scores,
          evidence, before, after, release_sha, created_at)
       SELECT '${eventId}', '${batchId}', 'release_smoke_probe',
              'taxonomy_state', '1', 'system', 'release-smoke', published_version,
              published_version, json_object('dispatchAttempts', ${Number(result.dispatch_attempts)}),
              'Cron dispatched outbox and queue consumer safely settled a stale-input job.',
              json_object('mode', mode), json_object('jobStatus', '${result.status}'),
              '${sqlLiteral(expectedRelease ?? config.vars?.RELEASE_SHA ?? 'unknown')}', ${auditTime}
       FROM taxonomy_state WHERE id = 1;
       DELETE FROM taxonomy_outbox WHERE job_id = '${jobId}';
       DELETE FROM taxonomy_jobs WHERE id = '${jobId}';`,
    )
    const retained = queryD1(
      database,
      `SELECT count(*) AS count FROM taxonomy_audit_events WHERE id = '${eventId}' AND job_id IS NULL`,
    )[0]
    if (Number(retained?.count) !== 1) {
      throw new Error('taxonomy smoke cleanup did not retain its audit event')
    }
  } catch (error) {
    try {
      executeD1(
        database,
        `DELETE FROM taxonomy_outbox WHERE job_id = '${jobId}'; DELETE FROM taxonomy_jobs WHERE id = '${jobId}';`,
      )
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `taxonomy smoke failed and probe cleanup also failed for ${jobId}`,
      )
    }
    throw error
  }
}

async function taxonomyReadOnlyProbe() {
  if (!queueInitiallyPaused) {
    throw new Error(
      'Read-only trigger verification is only valid for an observed paused queue.',
    )
  }
  const config = readJsonc(configPath)
  const { database, worker } = taxonomyResources(config)
  if (!database || !worker) {
    throw new Error('Taxonomy smoke requires a Worker name and DB binding.')
  }
  wrangler(['whoami'])
  const state = queryD1(
    database,
    `SELECT published_version, mode, circuit_state
     FROM taxonomy_state WHERE id = 1`,
  )[0]
  if (
    !state ||
    !Number.isInteger(Number(state.published_version)) ||
    !['disabled', 'shadow', 'gradual', 'autonomous', 'degraded'].includes(
      state.mode,
    )
  ) {
    throw new Error('taxonomy_state is missing or unreadable')
  }
}

function queryD1(database, sql) {
  const output = executeD1(database, sql)
  const result = JSON.parse(output)
  const statement = Array.isArray(result) ? result[0] : result
  if (!statement?.success) throw new Error('Remote D1 query was unsuccessful.')
  return statement.results ?? []
}

function executeD1(database, sql) {
  return wrangler([
    'd1',
    'execute',
    database,
    '--config',
    configPath,
    '--remote',
    '--json',
    '--command',
    sql,
  ])
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''")
}

async function request(path, init) {
  return fetch(new URL(path, baseUrl), init)
}

async function healthProbe() {
  const health = await request('/health', {
    headers: { Accept: 'application/json' },
  })
  expectStatus(health, 200, '/health')
  expectNoindex(health, '/health')
  const marker = await health.json()
  if (marker.status !== 'ok' || !marker.checks?.d1 || !marker.checks?.r2) {
    throw new Error('/health did not confirm D1 and R2 bindings')
  }
  if (expectedRelease && marker.release !== expectedRelease) {
    throw new Error(
      `expected release ${expectedRelease}, received ${marker.release}`,
    )
  }
}

async function html(path) {
  const response = await request(path, { headers: { Accept: 'text/html' } })
  expectStatus(response, 200, path)
  expectContentType(response, 'text/html', path)
  return { response, body: await response.text() }
}

function expectStatus(response, status, label) {
  if (response.status !== status)
    throw new Error(`${label} returned ${response.status}`)
}

function expectContentType(response, type, label) {
  if (!response.headers.get('content-type')?.includes(type)) {
    throw new Error(`${label} did not return ${type}`)
  }
}

function expectNoindex(response, label) {
  if (
    !response.headers.get('x-robots-tag')?.toLowerCase().includes('noindex')
  ) {
    throw new Error(`${label} did not return an X-Robots-Tag noindex directive`)
  }
}

function expectCanonical(body, expected, label) {
  const matches = [
    ...body.matchAll(
      /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    ),
  ]
  if (matches.length !== 1 || decodeHtml(matches[0]?.[1] || '') !== expected) {
    throw new Error(
      `${label} canonical URL was ${matches.map((match) => match[1]).join(', ') || 'missing'}`,
    )
  }
}

function expectMeta(body, attribute, key, expected, label) {
  const value = metaContent(body, attribute, key)
  if (value !== expected)
    throw new Error(`${label} ${key} was ${value || 'missing'}`)
}

function expectMetaPresent(body, attribute, key, label) {
  if (!metaContent(body, attribute, key))
    throw new Error(`${label} ${key} was missing`)
}

function metaContent(body, attribute, key) {
  const tags = body.match(/<meta\b[^>]*>/gi) || []
  for (const tag of tags) {
    const identity = tag.match(
      new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i'),
    )
    if (identity?.[1] !== key) continue
    return decodeHtml(tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || '')
  }
  return ''
}

function findJsonLd(body, type) {
  const scripts = body.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )
  for (const script of scripts) {
    const value = JSON.parse(decodeHtml(script[1]))
    const entries = value['@graph'] || [value]
    const match = entries.find((entry) => entry?.['@type'] === type)
    if (match) return match
  }
  throw new Error(`${type} JSON-LD was missing or invalid`)
}

async function checkDuplicateOrigin(duplicate, policy, options = {}) {
  let response
  try {
    response = await fetch(duplicate, { redirect: 'manual' })
  } catch (error) {
    if (options.optionalDns && error?.cause?.code === 'ENOTFOUND') {
      console.warn(`Optional duplicate origin ${duplicate} has no DNS record.`)
      return
    }
    throw error
  }
  if (policy === 'disabled' && response.status === 404) return
  if ([301, 308].includes(response.status)) {
    const location = new URL(response.headers.get('location'), duplicate)
    if (location.origin !== productionOrigin) {
      throw new Error(
        `${duplicate} redirected to non-canonical origin ${location.origin}`,
      )
    }
    return
  }
  throw new Error(
    `${duplicate} must ${policy === 'redirect' ? 'permanently redirect' : 'return 404 or permanently redirect'}; received ${response.status}`,
  )
}

async function realtimeProbe() {
  const websocketUrl = new URL('/api/realtime', baseUrl)
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('realtime WebSocket did not respond within 10 seconds'))
    }, 10_000)
    socket.addEventListener('open', () => socket.send('ping'))
    socket.addEventListener('message', (event) => {
      if (event.data !== 'pong') return
      clearTimeout(timeout)
      socket.close(1000, 'Smoke test complete')
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('realtime WebSocket connection failed'))
    })
  })
}

function expectMatch(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`${label} was missing or invalid`)
}

function decodeHtml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname)
}

async function retry(check) {
  let lastError
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      if (attempt < 6)
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
  throw lastError
}
