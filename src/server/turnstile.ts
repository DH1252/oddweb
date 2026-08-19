import { env } from 'cloudflare:workers'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'

import { clientAddress } from './public-identity'
import { parseHostnames, validateTurnstileResult } from '../lib/turnstile'
import type { SiteverifyResult } from '../lib/turnstile'

export { parseHostnames, validateTurnstileResult } from '../lib/turnstile'

export const turnstileActions = {
  submission: 'site_submission',
  guestbook: 'guestbook',
} as const

export async function requireTurnstile(
  token: unknown,
  action: (typeof turnstileActions)[keyof typeof turnstileActions],
) {
  const secret = env.TURNSTILE_SECRET
  const hostnames = parseHostnames(env.TURNSTILE_HOSTNAMES)
  if (!secret || hostnames.length === 0) {
    setResponseStatus(503)
    throw new Error('Bot protection is not configured for this deployment.')
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    await recordTurnstileFailure(action, ['missing-input-response'])
    setResponseStatus(403)
    throw new Error('Verification failed. Complete the check and try again.')
  }

  let result: SiteverifyResult
  try {
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          secret,
          response: token,
          remoteip: clientAddress(getRequest()),
          idempotency_key: crypto.randomUUID(),
        }),
      },
    )
    if (!response.ok) throw new Error(`siteverify ${response.status}`)
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object')
      throw new Error('Invalid siteverify response')
    result = parsed
  } catch (error) {
    console.error({
      event: 'turnstile_siteverify_unavailable',
      action,
      error: error instanceof Error ? error.message : String(error),
    })
    setResponseStatus(503)
    throw new Error('Verification is temporarily unavailable. Try again later.')
  }

  const validation = validateTurnstileResult(result, action, hostnames)
  if (!validation.valid) {
    await recordTurnstileFailure(action, validation.errors)
    setResponseStatus(403)
    throw new Error('Verification failed. Complete the check and try again.')
  }
  return validation
}

async function recordTurnstileFailure(action: string, errors: string[]) {
  try {
    await env.DB.prepare(
      `INSERT INTO turnstile_failures (action, error_code, attempted_at)
       VALUES (?1, ?2, unixepoch())`,
    )
      .bind(action, errors.slice(0, 3).join(',').slice(0, 200) || 'unknown')
      .run()
  } catch (error) {
    console.error({
      event: 'turnstile_failure_record_failed',
      action,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
