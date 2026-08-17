import {
  getRequest,
  setResponseHeader,
  setResponseStatus,
  useSession,
} from '@tanstack/react-start/server'
import { pbkdf2, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import {
  cleanupAuthRecords,
  clearLoginLimits,
  consumeLoginLimit,
  createAdminSession,
  getAdminSessionRecord,
  revokeAdminSession,
} from '../db/repository'

type AdminSession = {
  sessionId?: string
}

const sessionDurationSeconds = 8 * 60 * 60
const loginWindowSeconds = 15 * 60
const passwordHashIterations = 100_000
const derivePassword = promisify(pbkdf2)
const passwordHashPattern =
  /^\$pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

export async function readAdminSession() {
  const config = getAuthConfig(false)
  if (!config) return { authenticated: false as const, configured: false }
  const admin = await validAdminSession(config)
  return admin
    ? {
        authenticated: true as const,
        configured: true,
        username: admin.username,
      }
    : { authenticated: false as const, configured: true }
}

export async function authenticateAdmin(data: {
  username: string
  password: string
}) {
  const config = getAuthConfig(true)
  await cleanupAuthRecords()
  const limitKey = await loginLimitKey(config)
  const globalLimitKey = await globalLoginLimitKey(config)
  const [ipLimit, globalLimit] = await Promise.all([
    consumeLoginLimit(limitKey, 8, loginWindowSeconds),
    consumeLoginLimit(globalLimitKey, 40, loginWindowSeconds),
  ])
  if (!ipLimit.allowed) denyForRateLimit(ipLimit.retryAfter)
  if (!globalLimit.allowed) denyForRateLimit(globalLimit.retryAfter)

  const [usernameMatches, passwordMatches] = await Promise.all([
    secureEqual(data.username, config.username),
    verifyPassword(data.password, config.passwordHash),
  ])
  if (!usernameMatches || !passwordMatches) {
    setResponseStatus(401)
    throw new Error('Invalid username or password.')
  }

  await clearLoginLimits([limitKey, globalLimitKey])
  const cookieSession = await useSession<AdminSession>(
    sessionConfig(config.sessionSecret),
  )
  if (cookieSession.data.sessionId) {
    await revokeAdminSession(cookieSession.data.sessionId)
  }
  const sessionId = crypto.randomUUID()
  await createAdminSession({
    id: sessionId,
    username: config.username,
    credentialVersion: await credentialVersion(config),
    expiresAt: new Date(Date.now() + sessionDurationSeconds * 1000),
  })
  await cookieSession.update({ sessionId })
  return { success: true as const }
}

export async function destroyAdminSession() {
  const config = getAuthConfig(false)
  if (config) {
    const session = await useSession<AdminSession>(
      sessionConfig(config.sessionSecret),
    )
    if (session.data.sessionId) await revokeAdminSession(session.data.sessionId)
    await session.clear()
  }
  return { success: true as const }
}

export async function requireAdmin() {
  const config = getAuthConfig(true)
  const admin = await validAdminSession(config)
  if (!admin) {
    setResponseStatus(401)
    throw new Error('Unauthorized.')
  }
  return admin
}

async function validAdminSession(config: AuthConfig) {
  const cookieSession = await useSession<AdminSession>(
    sessionConfig(config.sessionSecret),
  )
  const sessionId = cookieSession.data.sessionId
  if (!sessionId) return null

  const record = await getAdminSessionRecord(sessionId)
  const valid =
    record &&
    !record.revokedAt &&
    record.expiresAt > new Date() &&
    record.username === config.username &&
    (await secureEqual(
      record.credentialVersion,
      await credentialVersion(config),
    ))
  if (!valid) {
    if (record && !record.revokedAt) await revokeAdminSession(sessionId)
    await cookieSession.clear()
    return null
  }
  return { username: record.username, sessionId: record.id }
}

type AuthConfig = {
  username: string
  passwordHash: string
  sessionSecret: string
}

function getAuthConfig(required: true): AuthConfig
function getAuthConfig(required: false): AuthConfig | null
function getAuthConfig(required: boolean) {
  const runtimeEnv: Record<string, string | undefined> = process.env
  const username = runtimeEnv.ADMIN_USERNAME
  const passwordHash = runtimeEnv.ADMIN_PASSWORD_HASH
  const sessionSecret = runtimeEnv.ADMIN_SESSION_SECRET

  if (
    !username ||
    !passwordHash ||
    !parsePasswordHash(passwordHash) ||
    !sessionSecret ||
    sessionSecret.length < 32
  ) {
    if (required) {
      setResponseStatus(503)
      throw new Error(
        'Admin authentication is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and a 32+ character ADMIN_SESSION_SECRET.',
      )
    }
    return null
  }

  return { username, passwordHash, sessionSecret }
}

function sessionConfig(password: string) {
  const request = getRequest()
  return {
    password,
    name: request.url.startsWith('https:')
      ? '__Host-oddweb-admin'
      : 'oddweb-admin',
    maxAge: sessionDurationSeconds,
    cookie: {
      httpOnly: true,
      secure: request.url.startsWith('https:'),
      sameSite: 'strict' as const,
      path: '/',
    },
  }
}

async function loginLimitKey(config: AuthConfig) {
  const request = getRequest()
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  return keyedHash(config.sessionSecret, `admin-login:ip:${ip}`)
}

async function globalLoginLimitKey(config: AuthConfig) {
  return keyedHash(config.sessionSecret, 'admin-login:global')
}

async function credentialVersion(config: AuthConfig) {
  return keyedHash(
    config.sessionSecret,
    `admin-credential:${config.username}:${config.passwordHash}`,
  )
}

async function keyedHash(secret: string, value: string) {
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
  return toHex(signature)
}

async function verifyPassword(password: string, encodedHash: string) {
  const parsed = parsePasswordHash(encodedHash)
  if (!parsed) return false
  const derived = await derivePassword(
    password,
    parsed.salt,
    parsed.iterations,
    32,
    'sha256',
  )
  return timingSafeEqual(derived, parsed.hash)
}

function parsePasswordHash(value: string) {
  const match = passwordHashPattern.exec(value)
  if (!match) return null
  const iterations = Number(match[1])
  const salt = Buffer.from(match[2], 'base64url')
  const hash = Buffer.from(match[3], 'base64url')
  if (
    iterations !== passwordHashIterations ||
    salt.byteLength < 16 ||
    hash.byteLength !== 32
  ) {
    return null
  }
  return { iterations, salt, hash }
}

async function secureEqual(actual: string, expected: string) {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(actual)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
  ])
  return timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))
}

function denyForRateLimit(retryAfter: number): never {
  setResponseStatus(429)
  setResponseHeader('Retry-After', String(Math.max(1, retryAfter)))
  throw new Error('Too many login attempts. Try again later.')
}

function toHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
