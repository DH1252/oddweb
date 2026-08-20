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

  // Different devices on the same IPv4 /24 subnet
  assert.equal(
    coarseNetworkAddress('192.168.1.42'),
    coarseNetworkAddress('192.168.1.99'),
  )

  // Different devices on the same IPv6 /64 customer network
  assert.equal(
    coarseNetworkAddress('2001:db8:abcd:12:1111:2222:3333:4444'),
    coarseNetworkAddress('2001:db8:abcd:12:5555:6666:7777:8888'),
  )

  // Devices on different subnets
  assert.notEqual(
    coarseNetworkAddress('192.168.1.42'),
    coarseNetworkAddress('192.168.2.42'),
  )
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

test('assertLegitimateClient blocks scrapers and permits normal browsers', async () => {
  const { assertLegitimateClient } = await import('../src/lib/public-identity')

  const legitRequest = new Request('https://oddweb.page', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
  assert.doesNotThrow(() => assertLegitimateClient(legitRequest))

  const botRequests = [
    new Request('https://oddweb.page', {
      headers: { 'user-agent': 'curl/7.88.1' },
    }),
    new Request('https://oddweb.page', {
      headers: { 'user-agent': 'python-requests/2.31.0' },
    }),
    new Request('https://oddweb.page', {
      headers: { 'user-agent': 'Go-http-client/2.0' },
    }),
    new Request('https://oddweb.page', {
      headers: { 'user-agent': 'PostmanRuntime/7.32.3' },
    }),
    new Request('https://oddweb.page', { headers: {} }),
  ]

  for (const botReq of botRequests) {
    assert.throws(
      () => assertLegitimateClient(botReq),
      /Automated request blocked/,
    )
  }
})
