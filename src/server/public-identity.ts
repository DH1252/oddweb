import { env } from 'cloudflare:workers'
import {
  getRequest,
  setResponseStatus,
  useSession,
} from '@tanstack/react-start/server'

import {
  coarseNetworkAddress,
  isLegitimateUserAgent,
  isPublicIdentityId,
} from '../lib/public-identity'

export {
  coarseNetworkAddress,
  isLegitimateUserAgent,
} from '../lib/public-identity'

const publicIdentityVersion = 1
const publicIdentityMaxAge = 365 * 24 * 60 * 60

export type PublicIdentity = {
  id: string
  issuedAt: number
  key: string
  isNew: boolean
}

type PublicSession = {
  version?: number
  id?: string
  issuedAt?: number
}

export async function getPublicIdentity(): Promise<PublicIdentity> {
  const secret = env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 32) {
    setResponseStatus(503)
    throw new Error('Public identity is unavailable until it is configured.')
  }

  const session = await useSession<PublicSession>(publicSessionConfig(secret))
  const existing = session.data
  const existingIssuedAt = existing.issuedAt
  if (
    existing.version === publicIdentityVersion &&
    typeof existing.id === 'string' &&
    isPublicIdentityId(existing.id) &&
    typeof existingIssuedAt === 'number' &&
    Number.isInteger(existingIssuedAt) &&
    existingIssuedAt > 0
  ) {
    const identity = {
      id: existing.id,
      issuedAt: existingIssuedAt,
      key: await hmacKey(secret, `public-identity:${existing.id}`),
      isNew: false,
    }
    await touchPublicIdentity(identity.key)
    return identity
  }

  const id = randomIdentityId()
  const issuedAt = Math.floor(Date.now() / 1000)
  await session.update({ version: publicIdentityVersion, id, issuedAt })
  const identity = {
    id,
    issuedAt,
    key: await hmacKey(secret, `public-identity:${id}`),
    isNew: true,
  }
  await touchPublicIdentity(identity.key)
  return identity
}

export async function touchPublicIdentity(
  identityKey: string,
  voteChange = false,
) {
  const now = Math.floor(Date.now() / 1000)
  try {
    await env.DB.prepare(
      `INSERT INTO public_identity_activity
         (identity_key, first_seen, last_seen, vote_changes)
       VALUES (?1, ?2, ?2, ?3)
       ON CONFLICT(identity_key) DO UPDATE SET
         last_seen = excluded.last_seen,
         vote_changes = min(1000000, public_identity_activity.vote_changes + excluded.vote_changes)`,
    )
      .bind(identityKey, now, voteChange ? 1 : 0)
      .run()
  } catch (error) {
    console.error({
      event: 'public_identity_activity_failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function assertLegitimateClient(request: Request) {
  const userAgent = request.headers.get('user-agent')
  if (!isLegitimateUserAgent(userAgent)) {
    setResponseStatus(403)
    throw new Error('Automated request blocked.')
  }
}

export function clientAddress(request: Request) {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  )
}

export async function publicScopeKeys(
  action: string,
  identity: PublicIdentity,
  request: Request,
) {
  const secret = env.ADMIN_SESSION_SECRET
  if (!secret) throw new Error('Public identity secret is not configured.')
  const address = clientAddress(request)
  return {
    identity: await hmacKey(
      secret,
      `public-limit:${action}:identity:${identity.key}`,
    ),
    exactIp: await hmacKey(secret, `public-limit:${action}:ip:${address}`),
    network: await hmacKey(
      secret,
      `public-limit:${action}:network:${coarseNetworkAddress(address)}`,
    ),
    global: await hmacKey(secret, `public-limit:${action}:global`),
    voteIdentity: await hmacKey(secret, `vote:${identity.key}`),
  }
}

export async function hmacKey(secret: string, value: string) {
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
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function publicSessionConfig(password: string) {
  const request = getRequest()
  const secure = request.url.startsWith('https:')
  return {
    password,
    name: secure ? '__Host-oddweb-public-v1' : 'oddweb-public-v1',
    maxAge: publicIdentityMaxAge,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
    },
  }
}

function randomIdentityId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

function toBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
