import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGeminiProvider,
  createOpenAICompatibleProvider,
  siteDecisionSchema,
  TaxonomyProviderError,
} from '../src/taxonomy'

const decision = {
  schemaVersion: 1 as const,
  decisions: [
    {
      tagId: 'listen',
      decision: 'assign' as const,
      confidence: 0.96,
      margin: 0.4,
      evidence: 'The site is centered on audio.',
    },
  ],
}

const request = {
  schema: siteDecisionSchema,
  schemaName: 'site_decision',
  systemPrompt: 'Classify only against the supplied catalog.',
  userPrompt: 'Site data: radio garden',
}

test('OpenAI Responses sends strict JSON schema and normalizes output and usage', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'openai-secret',
      model: 'gpt-test',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return Response.json(
          {
            id: 'resp_1',
            output_text: JSON.stringify(decision),
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          },
          { headers: { 'x-request-id': 'header-id' } },
        )
      },
    },
  )
  const result = await provider.generateStructured(request)
  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses')
  assert.equal(
    (capturedInit?.headers as Record<string, string>).authorization,
    'Bearer openai-secret',
  )
  assert.equal(capturedInit?.redirect, 'manual')
  const sent = JSON.parse(String(capturedInit.body)) as Record<string, unknown>
  const text = sent.text as {
    format: {
      strict: boolean
      schema: {
        $schema?: unknown
        additionalProperties?: boolean
        properties?: {
          schemaVersion?: { const?: unknown; enum?: unknown }
          decisions?: { maxItems?: unknown }
        }
      }
    }
  }
  const schema = text.format.schema
  const schemaVersion = schema.properties?.schemaVersion
  const decisions = schema.properties?.decisions
  assert.equal(text.format.strict, true)
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.$schema, undefined)
  assert.equal(schemaVersion?.const, undefined)
  assert.deepEqual(schemaVersion?.enum, [1])
  assert.equal(decisions?.maxItems, undefined)
  assert.equal(sent.max_output_tokens, 1_024)
  assert.deepEqual(result.data, decision)
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
  })
  assert.equal(result.providerRequestId, 'resp_1')
  assert.equal(result.attempts, 1)
})

test('OpenAI chat_completions handles compatible response fixtures', async () => {
  let sentBody: Record<string, unknown> | undefined
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'compatible-secret',
      model: 'local-model',
      dialect: 'chat_completions',
      endpoint: 'https://llm.example/v1/',
      allowedHosts: ['llm.example'],
      maxRetries: 0,
    },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://llm.example/v1/chat/completions')
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [{ message: { content: JSON.stringify(decision) } }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        })
      },
    },
  )
  const result = await provider.generateStructured(request)
  assert.equal(
    (sentBody?.response_format as { type: string }).type,
    'json_schema',
  )
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 9,
  })
})

test('Gemini uses the Interactions API with structured output schema', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const provider = createGeminiProvider(
    { apiKey: 'gemini-secret', model: 'gemini-test', maxRetries: 0 },
    {
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return Response.json({
          id: 'interaction-1',
          status: 'completed',
          steps: [
            { type: 'thought', signature: 'thought-signature' },
            {
              type: 'model_output',
              content: [{ type: 'text', text: JSON.stringify(decision) }],
            },
          ],
          usage: {
            total_input_tokens: 10,
            total_output_tokens: 6,
            total_tokens: 16,
          },
        })
      },
    },
  )
  const result = await provider.generateStructured(request)
  assert.equal(
    capturedUrl,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  )
  assert.equal(capturedUrl.includes('gemini-secret'), false)
  const headers = capturedInit?.headers as Record<string, string>
  assert.equal(headers['x-goog-api-key'], 'gemini-secret')
  assert.equal(headers['api-revision'], '2026-05-20')
  const sent = JSON.parse(String(capturedInit?.body)) as {
    model: string
    input: string
    system_instruction: string
    response_format: {
      type: string
      mime_type: string
      schema: Record<string, unknown>
    }
  }
  assert.equal(sent.model, 'gemini-test')
  assert.equal(sent.input, 'Site data: radio garden')
  assert.equal(
    sent.system_instruction,
    'Classify only against the supplied catalog.',
  )
  assert.equal(sent.response_format.mime_type, 'application/json')
  assert.ok(sent.response_format.schema)
  assert.equal(result.providerRequestId, 'interaction-1')
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 6,
    totalTokens: 16,
  })
})

test('Gemini accepts a complete Interactions endpoint without duplicating it', async () => {
  let capturedUrl = ''
  const provider = createGeminiProvider(
    {
      apiKey: 'gemini-secret',
      model: 'gemini-test',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      maxRetries: 0,
    },
    {
      fetch: async (input) => {
        capturedUrl = String(input)
        return Response.json({
          id: 'interaction-2',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: JSON.stringify(decision) }],
            },
          ],
        })
      },
    },
  )
  await provider.generateStructured(request)
  assert.equal(
    capturedUrl,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  )
})

test('retryable status is retried and normalized with Retry-After', async () => {
  let calls = 0
  const sleeps: number[] = []
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 2,
    },
    {
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          return Response.json(
            { error: { message: 'slow down' } },
            { status: 429, headers: { 'retry-after': '0.01' } },
          )
        }
        return Response.json({ output_text: JSON.stringify(decision) })
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    },
  )
  const result = await provider.generateStructured(request)
  assert.equal(result.attempts, 2)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [10])
})

test('contract violations are terminal and errors never expose provider secrets', async () => {
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'never-print-this-secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({ ...decision, unexpected: true }),
        }),
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'invalid_response')
      assert.equal(error.retryable, false)
      assert.equal(error.message.includes('never-print-this-secret'), false)
      return true
    },
  )
})

test('response byte caps stop oversized provider payloads', async () => {
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
      maxResponseBytes: 1_024,
    },
    {
      fetch: async () => new Response('x'.repeat(1_025)),
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'response_too_large')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('timeouts abort fetch and expose normalized retry metadata', async () => {
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
      timeoutMs: 100,
    },
    {
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'timeout')
      assert.equal(error.retryable, true)
      assert.equal(error.attempts, 1)
      assert.ok(error.latencyMs >= 90)
      return true
    },
  )
})

test('network failures expose bounded diagnostics without changing error metadata', async () => {
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: async () => {
        throw new TypeError('fetch failed: TLS certificate rejected')
      },
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'network')
      assert.equal(error.retryable, true)
      assert.match(error.message, /TypeError: fetch failed: TLS certificate/)
      assert.equal(error.message.includes('secret'), false)
      return true
    },
  )
})

test('provider fetch is invoked without the runtime object as its receiver', async () => {
  let receiver: unknown
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: function (this: unknown) {
        receiver = this
        return Promise.resolve(
          Response.json({ output_text: JSON.stringify(decision) }),
        )
      },
    },
  )
  await provider.generateStructured(request)
  assert.equal(receiver, undefined)
})

test('failed classification requests keep the provider status without storing error details', async () => {
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: async () =>
        Response.json(
          {
            error: {
              message:
                'Invalid schema for response_format: maxItems is not supported.',
            },
          },
          { status: 400 },
        ),
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'invalid_response')
      assert.equal(error.status, 400)
      assert.equal(error.retryable, false)
      assert.match(error.message, /400/)
      assert.doesNotMatch(error.message, /maxItems is not supported/)
      return true
    },
  )
})

test('provider redirects are exposed manually and rejected without following', async () => {
  let capturedRedirect: RequestRedirect | undefined
  const provider = createOpenAICompatibleProvider(
    {
      apiKey: 'secret',
      model: 'model',
      dialect: 'responses',
      maxRetries: 0,
    },
    {
      fetch: async (_input, init) => {
        capturedRedirect = init?.redirect
        return new Response(null, {
          status: 302,
          headers: { location: 'https://redirect.example/collect' },
        })
      },
    },
  )
  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) => {
      assert.ok(error instanceof TaxonomyProviderError)
      assert.equal(error.code, 'invalid_response')
      assert.equal(error.status, 302)
      assert.equal(error.retryable, false)
      return true
    },
  )
  assert.equal(capturedRedirect, 'manual')
})

test('unsafe custom endpoints fail before fetch is called', () => {
  let called = false
  assert.throws(
    () =>
      createOpenAICompatibleProvider(
        {
          apiKey: 'secret',
          model: 'model',
          dialect: 'responses',
          endpoint: 'https://127.0.0.1/v1',
        },
        {
          fetch: async () => {
            called = true
            return Response.json({})
          },
        },
      ),
    (error: unknown) =>
      error instanceof TaxonomyProviderError && error.code === 'configuration',
  )
  assert.equal(called, false)
})
