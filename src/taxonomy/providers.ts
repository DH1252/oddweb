import { z } from 'zod'

import { providerUrl, validateProviderEndpoint } from './endpoint'

export type ProviderErrorCode =
  | 'authentication'
  | 'configuration'
  | 'invalid_response'
  | 'network'
  | 'rate_limit'
  | 'response_too_large'
  | 'server'
  | 'timeout'

export class TaxonomyProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly attempts: number
  readonly latencyMs: number

  constructor(
    message: string,
    details: {
      code: ProviderErrorCode
      retryable: boolean
      status?: number
      attempts?: number
      latencyMs?: number
      cause?: unknown
    },
  ) {
    super(message, { cause: details.cause })
    this.name = 'TaxonomyProviderError'
    this.code = details.code
    this.retryable = details.retryable
    this.status = details.status
    this.attempts = details.attempts ?? 1
    this.latencyMs = details.latencyMs ?? 0
  }
}

export interface ProviderUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface StructuredProviderResult<T> {
  data: T
  usage: ProviderUsage
  attempts: number
  latencyMs: number
  providerRequestId: string | null
}

export interface StructuredProviderRequest<T> {
  schema: z.ZodType<T>
  schemaName: string
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}

export interface TaxonomyProvider {
  generateStructured: <T>(
    request: StructuredProviderRequest<T>,
  ) => Promise<StructuredProviderResult<T>>
}

export interface ProviderRuntimeOptions {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

interface SharedProviderConfig {
  apiKey: string
  model: string
  endpoint?: string
  allowedHosts?: readonly string[]
  timeoutMs?: number
  maxResponseBytes?: number
  maxRetries?: number
}

export interface OpenAICompatibleConfig extends SharedProviderConfig {
  dialect: 'responses' | 'chat_completions'
}

export interface GeminiConfig extends SharedProviderConfig {}

interface ResolvedRuntime {
  fetch: typeof fetch
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
}

interface ResolvedLimits {
  timeoutMs: number
  maxResponseBytes: number
  maxRetries: number
}

interface RawProviderResult {
  value: unknown
  usage: ProviderUsage
  providerRequestId: string | null
}

const emptyUsage: ProviderUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
}

function resolveRuntime(options: ProviderRuntimeOptions): ResolvedRuntime {
  const customFetch = options.fetch
  return {
    fetch: customFetch
      ? (input, init) => customFetch(input, init)
      : (input, init) => fetch(input, init),
    now: options.now ?? Date.now,
    sleep:
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
  }
}

function resolveLimits(config: SharedProviderConfig): ResolvedLimits {
  const timeoutMs = config.timeoutMs ?? 20_000
  const maxResponseBytes = config.maxResponseBytes ?? 256_000
  const maxRetries = config.maxRetries ?? 2
  if (!config.apiKey || !config.model) {
    throw new TaxonomyProviderError(
      'Provider credentials and model are required',
      {
        code: 'configuration',
        retryable: false,
      },
    )
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TaxonomyProviderError('Invalid provider timeout', {
      code: 'configuration',
      retryable: false,
    })
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 ||
    maxResponseBytes > 5_000_000
  ) {
    throw new TaxonomyProviderError('Invalid provider response size limit', {
      code: 'configuration',
      retryable: false,
    })
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new TaxonomyProviderError('Invalid provider retry limit', {
      code: 'configuration',
      retryable: false,
    })
  }
  return { timeoutMs, maxResponseBytes, maxRetries }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new TaxonomyProviderError('Provider response exceeded size limit', {
      code: 'response_too_large',
      retryable: false,
      status: response.status,
    })
  }
  if (!response.body) return ''

  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body.getReader()
  try {
    let result = await reader.read()
    while (!result.done) {
      const value = result.value
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new TaxonomyProviderError(
          'Provider response exceeded size limit',
          {
            code: 'response_too_large',
            retryable: false,
            status: response.status,
          },
        )
      }
      chunks.push(value)
      result = await reader.read()
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const unsupportedSchemaKeys = new Set([
  '$schema',
  '$id',
  '$comment',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'minContains',
  'maxContains',
  'uniqueItems',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
])

function providerJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeProviderSchema(z.toJSONSchema(schema)) as Record<
    string,
    unknown
  >
}

function sanitizeProviderSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProviderSchema)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (unsupportedSchemaKeys.has(key)) continue
    output[key] = sanitizeProviderSchema(child)
  }
  if (Object.hasOwn(output, 'const')) {
    if (!Object.hasOwn(output, 'enum')) output.enum = [output.const]
    delete output.const
  }
  return output
}

function providerErrorDetail(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>
    const error = body.error
    if (typeof error === 'string' && error.trim()) {
      return error.replaceAll(/\s+/g, ' ').trim().slice(0, 200)
    }
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) {
        return message.replaceAll(/\s+/g, ' ').trim().slice(0, 200)
      }
    }
  } catch {
    return null
  }
  return null
}

function responseError(status: number, bodyText = ''): TaxonomyProviderError {
  if (status === 401 || status === 403) {
    return new TaxonomyProviderError('Provider authentication failed', {
      code: 'authentication',
      retryable: false,
      status,
    })
  }
  if (status === 429) {
    return new TaxonomyProviderError('Provider rate limit exceeded', {
      code: 'rate_limit',
      retryable: true,
      status,
    })
  }
  if (status >= 300 && status < 400) {
    return new TaxonomyProviderError(
      `Provider returned a redirect (${status})`,
      {
        code: 'invalid_response',
        retryable: false,
        status,
      },
    )
  }
  const retryable = status === 408 || status === 409 || status >= 500
  const detail = providerErrorDetail(bodyText)
  return new TaxonomyProviderError(
    detail
      ? `Provider request failed (${status}): ${detail}`
      : `Provider request failed (${status})`,
    {
      code: status >= 500 ? 'server' : 'invalid_response',
      retryable,
      status,
    },
  )
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, 30_000)
  }
  return Math.min(250 * 2 ** (attempt - 1), 5_000)
}

function networkErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return 'Provider network request failed'
  const detail = `${cause.name}: ${cause.message}`
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return detail
    ? `Provider network request failed (${detail})`
    : 'Provider network request failed'
}

async function executeRequest(
  url: URL,
  init: RequestInit,
  limits: ResolvedLimits,
  runtime: ResolvedRuntime,
  signal: AbortSignal | undefined,
): Promise<{
  body: unknown
  response: Response
  attempts: number
  latencyMs: number
}> {
  const startedAt = runtime.now()
  let lastError: TaxonomyProviderError | undefined

  for (let attempt = 1; attempt <= limits.maxRetries + 1; attempt += 1) {
    const controller = new AbortController()
    const timeoutReason = new DOMException(
      'Provider request timed out',
      'TimeoutError',
    )
    const timeout = setTimeout(() => {
      controller.abort(timeoutReason)
    }, limits.timeoutMs)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let response: Response | undefined
    try {
      response = await runtime.fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      })
      const text = await readBoundedResponse(response, limits.maxResponseBytes)
      if (!response.ok) throw responseError(response.status, text)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch (cause) {
        throw new TaxonomyProviderError('Provider returned invalid JSON', {
          code: 'invalid_response',
          retryable: false,
          status: response.status,
          cause,
        })
      }
      return {
        body,
        response,
        attempts: attempt,
        latencyMs: Math.max(0, runtime.now() - startedAt),
      }
    } catch (cause) {
      if (cause instanceof TaxonomyProviderError) {
        lastError = cause
      } else if (
        controller.signal.aborted &&
        controller.signal.reason instanceof DOMException &&
        controller.signal.reason.name === 'TimeoutError'
      ) {
        lastError = new TaxonomyProviderError('Provider request timed out', {
          code: 'timeout',
          retryable: true,
          cause,
        })
      } else if (signal?.aborted) {
        const deadlineExceeded =
          signal.reason instanceof DOMException &&
          signal.reason.name === 'TimeoutError'
        lastError = new TaxonomyProviderError(
          deadlineExceeded
            ? 'Taxonomy job provider deadline exceeded'
            : 'Provider request was aborted',
          {
            code: deadlineExceeded ? 'timeout' : 'network',
            retryable: deadlineExceeded,
            cause,
          },
        )
      } else {
        lastError = new TaxonomyProviderError(networkErrorMessage(cause), {
          code: 'network',
          retryable: true,
          cause,
        })
      }
      if (!lastError.retryable || attempt > limits.maxRetries) {
        throw new TaxonomyProviderError(lastError.message, {
          code: lastError.code,
          retryable: lastError.retryable,
          status: lastError.status,
          attempts: attempt,
          latencyMs: Math.max(0, runtime.now() - startedAt),
          cause: lastError.cause,
        })
      }
      await runtime.sleep(retryDelay(response, attempt))
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw lastError
}

function parseStructuredText(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TaxonomyProviderError('Provider omitted structured output', {
      code: 'invalid_response',
      retryable: false,
    })
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new TaxonomyProviderError(
      'Provider structured output was invalid JSON',
      {
        code: 'invalid_response',
        retryable: false,
        cause,
      },
    )
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function openAIResult(
  body: unknown,
  dialect: OpenAICompatibleConfig['dialect'],
): RawProviderResult {
  if (!body || typeof body !== 'object') {
    throw new TaxonomyProviderError('Provider returned an invalid response', {
      code: 'invalid_response',
      retryable: false,
    })
  }
  const record = body as Record<string, unknown>
  let text: unknown
  if (dialect === 'responses') {
    text = record.output_text
    if (typeof text !== 'string' && Array.isArray(record.output)) {
      text = record.output
        .flatMap((item) =>
          item &&
          typeof item === 'object' &&
          Array.isArray((item as Record<string, unknown>).content)
            ? ((item as Record<string, unknown>).content as unknown[])
            : [],
        )
        .find(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).text === 'string',
        )
      text =
        text && typeof text === 'object'
          ? (text as Record<string, unknown>).text
          : text
    }
  } else {
    const choices = Array.isArray(record.choices) ? record.choices : []
    const first = choices[0] as Record<string, unknown> | undefined
    const message = first?.message as Record<string, unknown> | undefined
    text = message?.content
  }
  const usage = (record.usage ?? {}) as Record<string, unknown>
  return {
    value: parseStructuredText(text),
    usage: {
      inputTokens: numberOrNull(usage.input_tokens ?? usage.prompt_tokens),
      outputTokens: numberOrNull(
        usage.output_tokens ?? usage.completion_tokens,
      ),
      totalTokens: numberOrNull(usage.total_tokens),
    },
    providerRequestId: typeof record.id === 'string' ? record.id : null,
  }
}

function geminiInteractionsResult(body: unknown): RawProviderResult {
  if (!body || typeof body !== 'object') {
    throw new TaxonomyProviderError('Provider returned an invalid response', {
      code: 'invalid_response',
      retryable: false,
    })
  }
  const record = body as Record<string, unknown>
  const steps = Array.isArray(record.steps) ? record.steps : []
  const text = steps
    .filter(
      (step): step is Record<string, unknown> =>
        Boolean(step) && typeof step === 'object',
    )
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => {
      const content = Array.isArray(step.content) ? step.content : []
      return content
        .filter(
          (part): part is Record<string, unknown> =>
            Boolean(part) && typeof part === 'object',
        )
        .map((part) => part.text)
        .filter((value) => typeof value === 'string')
    })
    .filter((value) => value.trim())
    .join('\n')
  const usage = (record.usage ?? {}) as Record<string, unknown>
  return {
    value: parseStructuredText(text),
    usage: {
      inputTokens: numberOrNull(usage.total_input_tokens),
      outputTokens: numberOrNull(usage.total_output_tokens),
      totalTokens: numberOrNull(usage.total_tokens),
    },
    providerRequestId: typeof record.id === 'string' ? record.id : null,
  }
}

function parseWithContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new TaxonomyProviderError(
      'Provider output violated the response contract',
      {
        code: 'invalid_response',
        retryable: false,
        cause: result.error,
      },
    )
  }
  return result.data
}

function completeStructuredResult<T>(
  result: {
    body: unknown
    response: Response
    attempts: number
    latencyMs: number
  },
  schema: z.ZodType<T>,
  parse: (body: unknown) => RawProviderResult,
): StructuredProviderResult<T> {
  try {
    const parsed = parse(result.body)
    return {
      data: parseWithContract(schema, parsed.value),
      usage: parsed.usage,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      providerRequestId:
        parsed.providerRequestId ?? result.response.headers.get('x-request-id'),
    }
  } catch (cause) {
    if (cause instanceof TaxonomyProviderError) {
      throw new TaxonomyProviderError(cause.message, {
        code: cause.code,
        retryable: cause.retryable,
        status: cause.status,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        cause: cause.cause,
      })
    }
    throw cause
  }
}

function endpoint(
  value: string,
  allowedHosts: readonly string[] | undefined,
): URL {
  try {
    return validateProviderEndpoint(value, { allowedHosts })
  } catch (cause) {
    throw new TaxonomyProviderError('Unsafe provider endpoint', {
      code: 'configuration',
      retryable: false,
      cause,
    })
  }
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  runtimeOptions: ProviderRuntimeOptions = {},
): TaxonomyProvider {
  if (config.endpoint && !config.allowedHosts?.length) {
    throw new TaxonomyProviderError(
      'Custom provider endpoints require an explicit host allowlist',
      { code: 'configuration', retryable: false },
    )
  }
  const limits = resolveLimits(config)
  const runtime = resolveRuntime(runtimeOptions)
  const baseUrl = endpoint(
    config.endpoint ?? 'https://api.openai.com/v1',
    config.allowedHosts,
  )

  return {
    async generateStructured<T>(request: StructuredProviderRequest<T>) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName)) {
        throw new TaxonomyProviderError(
          'Invalid structured output schema name',
          {
            code: 'configuration',
            retryable: false,
          },
        )
      }
      const jsonSchema = providerJsonSchema(request.schema)
      const isResponses = config.dialect === 'responses'
      const body = isResponses
        ? {
            model: config.model,
            input: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: request.schemaName,
                strict: true,
                schema: jsonSchema,
              },
            },
          }
        : {
            model: config.model,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: jsonSchema,
              },
            },
          }
      const result = await executeRequest(
        providerUrl(baseUrl, isResponses ? 'responses' : 'chat/completions'),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        limits,
        runtime,
        request.signal,
      )
      return completeStructuredResult(result, request.schema, (responseBody) =>
        openAIResult(responseBody, config.dialect),
      )
    },
  }
}

export function createGeminiProvider(
  config: GeminiConfig,
  runtimeOptions: ProviderRuntimeOptions = {},
): TaxonomyProvider {
  const limits = resolveLimits(config)
  const runtime = resolveRuntime(runtimeOptions)
  const baseUrl = endpoint(
    config.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta',
    config.allowedHosts ?? ['generativelanguage.googleapis.com'],
  )

  return {
    async generateStructured<T>(request: StructuredProviderRequest<T>) {
      const body = {
        model: config.model,
        input: request.userPrompt,
        system_instruction: request.systemPrompt,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: providerJsonSchema(request.schema),
        },
      }
      const interactionUrl = baseUrl.pathname.endsWith('/interactions')
        ? baseUrl
        : providerUrl(baseUrl, 'interactions')
      const result = await executeRequest(
        interactionUrl,
        {
          method: 'POST',
          headers: {
            'api-revision': '2026-05-20',
            'content-type': 'application/json',
            'x-goog-api-key': config.apiKey,
          },
          body: JSON.stringify(body),
        },
        limits,
        runtime,
        request.signal,
      )
      return completeStructuredResult(
        result,
        request.schema,
        geminiInteractionsResult,
      )
    },
  }
}

export function emptyProviderUsage(): ProviderUsage {
  return { ...emptyUsage }
}
