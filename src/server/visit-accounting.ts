import { env, waitUntil } from 'cloudflare:workers'

import { recordAtomicVisit, VisitRepositoryError } from '../db/visit-repository'

export type DeferredVisitInput = {
  request: Request
  slug: string
  database?: D1Database
  secret?: string
}

export type DeferredVisitAccepted = {
  accepted: true
}

export class VisitAccountingError extends Error {
  constructor(
    readonly code:
      'VISIT_ACCOUNTING_INVALID_INPUT' | 'VISIT_ACCOUNTING_NOT_CONFIGURED',
    message: string,
  ) {
    super(message)
    this.name = 'VisitAccountingError'
  }
}

export function visitorAddress(request: Request) {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

export async function visitorVisitKey(
  request: Request,
  slug: string,
  secret: string,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`visit:${slug}:ip:${visitorAddress(request)}`),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function deferVisitAccounting({
  request,
  slug,
  database = env.DB,
  secret = env.ADMIN_SESSION_SECRET,
}: DeferredVisitInput): Promise<DeferredVisitAccepted> {
  if (!slug || slug.length > 100) {
    throw new VisitAccountingError(
      'VISIT_ACCOUNTING_INVALID_INPUT',
      'A valid site slug is required.',
    )
  }
  if (!secret) {
    throw new VisitAccountingError(
      'VISIT_ACCOUNTING_NOT_CONFIGURED',
      'Visit accounting is not configured.',
    )
  }

  const visitorKey = await visitorVisitKey(request, slug, secret)
  waitUntil(
    recordAtomicVisit(database, { slug, visitorKey }).catch(
      (error: unknown) => {
        console.error({
          event: 'visit_accounting_failed',
          code:
            error instanceof VisitRepositoryError
              ? error.code
              : 'VISIT_ACCOUNTING_UNEXPECTED_ERROR',
          slug,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    ),
  )

  return { accepted: true }
}
