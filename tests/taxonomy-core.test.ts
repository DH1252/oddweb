import assert from 'node:assert/strict'
import test from 'node:test'

import {
  circuitStatus,
  decryptProviderKey,
  encryptProviderKey,
  hashTaxonomyInput,
  normalizeTaxonomySiteInput,
  ontologyProposalResponseSchema,
  parseProviderKeyEnvelope,
  parseTaxonomyPolicy,
  sha256Hex,
  siteDecisionSchema,
  stableJson,
  taxonomyJobKey,
  validateProviderEndpoint,
  validateSiteDecisions,
} from '../src/taxonomy'

test('taxonomy input normalization and hashes are stable', async () => {
  const left = {
    siteId: 7,
    name: '  Odd\u00a0 Site  ',
    description: 'Line\n break',
    tags: [' Calm ', 'calm', 'ＡＵＤＩＯ'],
    url: 'https://example.com',
  }
  const right = {
    siteId: '7',
    name: 'Odd Site',
    description: 'Line break',
    tags: ['audio', 'CALM'],
    url: 'https://example.com/',
  }
  assert.deepEqual(normalizeTaxonomySiteInput(left), {
    siteId: '7',
    name: 'Odd Site',
    description: 'Line break',
    tags: ['audio', 'calm'],
    url: 'https://example.com/',
  })
  assert.equal(await hashTaxonomyInput(left), await hashTaxonomyInput(right))
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(
    stableJson({ z: 1, a: { y: 2, x: 1 } }),
    '{"a":{"x":1,"y":2},"z":1}',
  )
})

test('job keys validate hashes and escape mutable identifiers', () => {
  const key = taxonomyJobKey({
    siteId: 'site:7',
    inputHash: 'A'.repeat(64),
    taxonomyVersion: 3,
    classifierVersion: 'model:v1',
  })
  assert.equal(
    key,
    `site:site%3A7:input:${'a'.repeat(64)}:taxonomy:3:classifier:model%3Av1`,
  )
  assert.throws(
    () =>
      taxonomyJobKey({
        siteId: 1,
        inputHash: 'nope',
        taxonomyVersion: 1,
        classifierVersion: 1,
      }),
    /SHA-256/,
  )
})

test('site decision and ontology contracts reject unknown and malformed data', () => {
  const valid = siteDecisionSchema.parse({
    schemaVersion: 1,
    decisions: [
      {
        tagId: 'tag-1',
        decision: 'assign',
        confidence: 0.95,
        margin: 0.3,
        evidence: 'Directly supported by the description.',
      },
    ],
  })
  assert.equal(valid.decisions[0]?.tagId, 'tag-1')
  assert.equal(
    siteDecisionSchema.safeParse({ ...valid, commentary: 'extra prose' })
      .success,
    false,
  )
  assert.equal(
    siteDecisionSchema.safeParse({
      schemaVersion: 1,
      decisions: [{ ...valid.decisions[0], confidence: 1.1 }],
    }).success,
    false,
  )
  assert.equal(
    siteDecisionSchema.safeParse({
      schemaVersion: 1,
      decisions: [
        valid.decisions[0],
        { ...valid.decisions[0], decision: 'do_not_assign' },
      ],
    }).success,
    false,
  )
  assert.equal(
    ontologyProposalResponseSchema.safeParse({
      schemaVersion: 1,
      proposals: [
        {
          kind: 'parent',
          childTagId: 'one',
          parentTagId: 'two',
          confidence: 0.8,
          evidence: 'Repeated hierarchical usage.',
        },
      ],
    }).success,
    true,
  )
  assert.equal(
    ontologyProposalResponseSchema.safeParse({
      schemaVersion: 1,
      proposals: [{ kind: 'concept', proposedSlug: '../admin' }],
    }).success,
    false,
  )
})

test('policy separates automatic, review, rejected, and unknown decisions', () => {
  const response = siteDecisionSchema.parse({
    schemaVersion: 1,
    decisions: [
      {
        tagId: 'a',
        decision: 'assign',
        confidence: 0.95,
        margin: 0.2,
        evidence: 'a',
      },
      {
        tagId: 'b',
        decision: 'assign',
        confidence: 0.91,
        margin: 0.05,
        evidence: 'b',
      },
      {
        tagId: 'c',
        decision: 'review',
        confidence: 0.7,
        margin: 0.2,
        evidence: 'c',
      },
      {
        tagId: 'd',
        decision: 'assign',
        confidence: 0.99,
        margin: 0.5,
        evidence: 'd',
      },
    ],
  })
  const result = validateSiteDecisions(response, new Set(['a', 'b', 'c']))
  assert.deepEqual(
    result.automatic.map(({ tagId }) => tagId),
    ['a'],
  )
  assert.deepEqual(
    result.review.map(({ tagId }) => tagId),
    ['b', 'c'],
  )
  assert.deepEqual(
    result.rejected.map(({ tagId }) => tagId),
    ['d'],
  )
  assert.deepEqual(result.violations, ['unknown tag: d'])
  assert.throws(
    () =>
      parseTaxonomyPolicy({ reviewThreshold: 0.95, autoAssignThreshold: 0.9 }),
    /cannot exceed/,
  )
})

test('circuit thresholds progress from closed through open and half-open', () => {
  const policy = {
    circuitFailureThreshold: 3,
    circuitWindowMs: 1_000,
    circuitCooldownMs: 2_000,
  }
  assert.equal(circuitStatus({ failures: [1, 2] }, 500, policy), 'closed')
  assert.equal(circuitStatus({ failures: [1, 2, 3] }, 500, policy), 'open')
  assert.equal(circuitStatus({ failures: [1, 2, 3] }, 5_000, policy), 'closed')
  assert.equal(
    circuitStatus({ failures: [], openedAt: 1_000 }, 2_000, policy),
    'open',
  )
  assert.equal(
    circuitStatus({ failures: [], openedAt: 1_000 }, 3_000, policy),
    'half_open',
  )
})

test('AES-GCM provider key envelopes round-trip and bind key id and context', async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index)
  const envelope = await encryptProviderKey('provider-secret', key, {
    keyId: 'master-2026-08',
    context: 'provider:17',
    iv: new Uint8Array(12).fill(7),
  })
  assert.equal(envelope.includes('provider-secret'), false)
  assert.equal(parseProviderKeyEnvelope(envelope).kid, 'master-2026-08')
  assert.equal(
    await decryptProviderKey(
      envelope,
      (keyId) => {
        assert.equal(keyId, 'master-2026-08')
        return key
      },
      { context: 'provider:17' },
    ),
    'provider-secret',
  )
  await assert.rejects(
    decryptProviderKey(envelope, () => key, { context: 'provider:18' }),
    /Unable to decrypt/,
  )

  const parsed = JSON.parse(envelope) as { ciphertext: string }
  parsed.ciphertext = `${parsed.ciphertext.slice(0, -1)}${parsed.ciphertext.endsWith('A') ? 'B' : 'A'}`
  await assert.rejects(
    decryptProviderKey(JSON.stringify(parsed), () => key, {
      context: 'provider:17',
    }),
    /Unable to decrypt/,
  )
})

test('endpoint validation blocks common SSRF targets and supports host allowlists', () => {
  for (const unsafe of [
    'http://api.openai.com/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.1.2.3/v1',
    'https://169.254.169.254/latest',
    'https://[::1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://service.internal/v1',
    'https://user:pass@example.com/v1',
    'https://example.com:8443/v1',
    'https://example.com/v1?key=secret',
  ]) {
    assert.throws(() => validateProviderEndpoint(unsafe), TypeError, unsafe)
  }
  assert.equal(
    validateProviderEndpoint('https://API.OPENAI.COM/v1/', {
      allowedHosts: ['api.openai.com'],
    }).href,
    'https://api.openai.com/v1',
  )
  assert.throws(
    () =>
      validateProviderEndpoint('https://attacker.example/v1', {
        allowedHosts: ['api.openai.com'],
      }),
    /not allowed/,
  )
})
