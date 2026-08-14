import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseRealtimeEvent } from '../src/realtime/events'

test('realtime events accept bounded public changes', () => {
  assert.deepEqual(parseRealtimeEvent({ type: 'guestbook.changed' }), {
    type: 'guestbook.changed',
  })
  assert.deepEqual(parseRealtimeEvent({ type: 'directory.changed' }), {
    type: 'directory.changed',
  })
  assert.deepEqual(
    parseRealtimeEvent({
      type: 'site.viewed',
      slug: 'radio-garden',
      views: 42,
    }),
    { type: 'site.viewed', slug: 'radio-garden', views: 42 },
  )
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
  assert.equal(parseRealtimeEvent({ type: 'unknown' }), null)
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
