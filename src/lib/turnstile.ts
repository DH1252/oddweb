export const turnstileActions = {
  submission: 'site_submission',
  guestbook: 'guestbook',
  vote: 'site_vote',
} as const

export type TurnstileAction =
  (typeof turnstileActions)[keyof typeof turnstileActions]

export type SiteverifyResult = {
  success?: boolean
  action?: string
  hostname?: string
  challenge_ts?: string
  ['error-codes']?: string[]
}

export function parseHostnames(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean)
}

export function validateTurnstileResult(
  result: SiteverifyResult,
  action: string,
  hostnames: string[],
) {
  const errors = result['error-codes'] ?? []
  if (!result.success) return { valid: false as const, errors }
  if (result.action !== action) {
    return { valid: false as const, errors: [...errors, 'action-mismatch'] }
  }
  if (!result.hostname || !hostnames.includes(result.hostname.toLowerCase())) {
    return { valid: false as const, errors: [...errors, 'hostname-mismatch'] }
  }
  return { valid: true as const, action, hostname: result.hostname }
}
