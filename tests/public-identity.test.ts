import assert from 'node:assert/strict'
import test from 'node:test'

import { parseHostnames, validateTurnstileResult } from '../src/lib/turnstile'
import { coarseNetworkAddress } from '../src/lib/public-identity'

test('coarse network keys group IPv4 and IPv6 addresses', () => {
  assert.equal(coarseNetworkAddress('192.0.2.44'), '192.0.2.0/24')
  assert.equal(
    coarseNetworkAddress('2001:db8:abcd:12::44'),
    '2001:0db8:abcd:0012::/64',
  )
  assert.equal(coarseNetworkAddress('local'), 'local')
})

test('Turnstile validation requires success, exact action, and hostname', () => {
  const valid = validateTurnstileResult(
    { success: true, action: 'guestbook', hostname: 'oddweb.page' },
    'guestbook',
    ['oddweb.page'],
  )
  assert.deepEqual(valid, {
    valid: true,
    action: 'guestbook',
    hostname: 'oddweb.page',
  })
  assert.equal(
    validateTurnstileResult(
      { success: true, action: 'site_submission', hostname: 'oddweb.page' },
      'guestbook',
      ['oddweb.page'],
    ).valid,
    false,
  )
  assert.equal(
    validateTurnstileResult(
      { success: true, action: 'guestbook', hostname: 'localhost' },
      'guestbook',
      ['oddweb.page'],
    ).valid,
    false,
  )
  assert.deepEqual(parseHostnames(' Oddweb.Page, localhost, ,127.0.0.1 '), [
    'oddweb.page',
    'localhost',
    '127.0.0.1',
  ])
})
