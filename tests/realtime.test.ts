import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseRealtimeEvent } from '../src/realtime/events'
import { isAdminPath } from '../src/components/realtime-sync-path'

test('realtime events accept bounded public changes', () => {
  assert.deepEqual(parseRealtimeEvent({ type: 'guestbook.changed' }), {
    type: 'guestbook.changed',
  })
  assert.deepEqual(parseRealtimeEvent({ type: 'submission.changed' }), {
    type: 'submission.changed',
  })
  assert.deepEqual(parseRealtimeEvent({ type: 'directory.changed' }), {
    type: 'directory.changed',
  })
  assert.deepEqual(parseRealtimeEvent({ type: 'taxonomy.changed' }), {
    type: 'taxonomy.changed',
  })
  assert.deepEqual(
    parseRealtimeEvent({
      type: 'site.viewed',
      slug: 'radio-garden',
      views: 42,
    }),
    { type: 'site.viewed', slug: 'radio-garden', views: 42 },
  )
  assert.deepEqual(
    parseRealtimeEvent({
      type: 'site.voted',
      slug: 'radio-garden',
      votes: 12,
    }),
    { type: 'site.voted', slug: 'radio-garden', votes: 12 },
  )
})

test('realtime resyncs admin and taxonomy state after missed events', async () => {
  const source = await readFile(
    new URL('../src/components/realtime-sync.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /const resync = async/)
  assert.match(source, /queryKey: \['oddweb', 'admin'\]/)
  assert.match(source, /queryKey: \['oddweb', 'tags'\]/)
  assert.match(source, /event\.type === 'taxonomy\.changed'/)
  assert.match(source, /event\.type === 'submission\.changed'/)
  assert.match(source, /queryKey: \['oddweb', 'admin', 'submissions'\]/)
  assert.match(source, /queryKey: \['oddweb', 'admin', 'overview'\]/)
  assert.match(source, /queryKey: \['oddweb', 'admin', 'sites'\]/)
  assert.match(source, /queryKey: \['oddweb', 'admin', 'site'\]/)
  assert.match(source, /queryKey: \['oddweb', 'public', 'support'\]/)
  assert.match(source, /void resync\(\)[\s\S]*if\s*\(\s*!socket/)
})

test('realtime events reject malformed or unbounded messages', () => {
  assert.equal(parseRealtimeEvent(null), null)
  assert.equal(
    parseRealtimeEvent({ type: 'site.viewed', slug: '', views: 1 }),
    null,
  )
  assert.equal(
    parseRealtimeEvent({ type: 'site.viewed', slug: 'valid', views: -1 }),
    null,
  )
  assert.equal(
    parseRealtimeEvent({ type: 'site.voted', slug: '', votes: 1 }),
    null,
  )
  assert.equal(
    parseRealtimeEvent({ type: 'site.voted', slug: 'valid', votes: -1 }),
    null,
  )
  assert.equal(parseRealtimeEvent({ type: 'unknown' }), null)
})

test('admin pages keep the realtime socket connected while hidden', async () => {
  assert.equal(isAdminPath('/admin'), true)
  assert.equal(isAdminPath('/admin/sites'), true)
  assert.equal(isAdminPath('/admin/login'), true)
  assert.equal(isAdminPath('/'), false)
  assert.equal(isAdminPath('/tags'), false)
  assert.equal(isAdminPath('/administer'), false)

  const source = await readFile(
    new URL('../src/components/realtime-sync.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /isAdminPath\(window\.location\.pathname\)/)
  assert.match(source, /visibilityState === 'hidden'[\s\S]*socket\?\.close/)
  assert.match(source, /window\.addEventListener\('focus', handleActive\)/)
  assert.match(source, /window\.addEventListener\('pageshow', handleActive\)/)
  assert.match(source, /window\.addEventListener\('online', handleActive\)/)
})

test('public submissions publish a realtime event', async () => {
  const source = await readFile(
    new URL('../src/server/data.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /export const submitSite[\s\S]*publishRealtimeEvent\(\{ type: 'submission\.changed' \}\)/,
  )
})

test('public votes publish a realtime event', async () => {
  const source = await readFile(
    new URL('../src/server/data.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /export const toggleSiteVote[\s\S]*publishRealtimeEvent\(\{[\s\S]*type: 'site\.voted'/,
  )
})

test('realtime Durable Object uses a hibernating WebSocket binding', async () => {
  const config = JSON.parse(
    (await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1'),
  )
  assert.deepEqual(config.durable_objects.bindings, [
    { name: 'REALTIME_HUB', class_name: 'RealtimeHub' },
  ])
  assert.deepEqual(config.migrations, [
    { tag: 'v1-realtime-hub', new_sqlite_classes: ['RealtimeHub'] },
  ])

  const source = await readFile(
    new URL('../src/realtime/hub.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /acceptWebSocket/)
  assert.match(source, /getWebSockets/)
})

test('realtime clients heartbeat and the hub logs close codes', async () => {
  const [client, hub] = await Promise.all([
    readFile(
      new URL('../src/components/realtime-sync.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/realtime/hub.ts', import.meta.url), 'utf8'),
  ])
  assert.match(
    client,
    /socket\.send\('ping'\)[\s\S]*setInterval\(heartbeat, 25_000\)/,
  )
  assert.match(client, /clearInterval\(heartbeatTimer\)/)
  assert.match(
    hub,
    /webSocketClose\([\s\S]*code: number[\s\S]*wasClean: boolean/,
  )
  assert.match(hub, /event: 'realtime_client_disconnected'/)
  assert.match(hub, /durationMs/)
  assert.match(hub, /console\.warn\(record\)/)
  assert.match(hub, /event: 'realtime_socket_error'/)
})
