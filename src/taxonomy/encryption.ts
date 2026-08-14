const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

export interface ProviderKeyEnvelopeV1 {
  v: 1
  alg: 'A256GCM'
  kid: string
  iv: string
  ciphertext: string
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid base64url')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function envSecret(env: object, name: string): string | undefined {
  const value = Reflect.get(env, name)
  return typeof value === 'string' && value ? value : undefined
}

export function resolveTaxonomyMasterKey(
  env: object,
  keyVersion: number,
): Uint8Array {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError('Invalid taxonomy master-key version')
  }
  const encoded =
    envSecret(env, `TAXONOMY_MASTER_KEY_V${keyVersion}`) ??
    (keyVersion === 1 ? envSecret(env, 'TAXONOMY_MASTER_KEY') : undefined)
  if (!encoded) {
    throw new Error(`Taxonomy master key version ${keyVersion} is unavailable`)
  }
  return decodeEncryptionKey(encoded)
}

function storedCredentialData(
  providerId: number,
  keyVersion: number,
): Uint8Array {
  return encoder.encode(
    `oddweb:taxonomy-provider-credential:v1:${providerId}:${keyVersion}`,
  )
}

export async function decryptStoredProviderCredential(
  input: {
    providerId: number
    keyVersion: number
    nonce: string
    ciphertext: string
  },
  env: object,
): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(base64UrlToBytes(input.nonce)),
        additionalData: arrayBuffer(
          storedCredentialData(input.providerId, input.keyVersion),
        ),
        tagLength: 128,
      },
      await aesKey(resolveTaxonomyMasterKey(env, input.keyVersion)),
      arrayBuffer(base64UrlToBytes(input.ciphertext)),
    )
    return decoder.decode(plaintext)
  } catch {
    throw new Error('Unable to decrypt provider credential')
  }
}

export async function encryptStoredProviderCredential(
  plaintext: string,
  input: {
    providerId: number
    keyVersion: number
    env: object
    nonce?: Uint8Array
  },
): Promise<{ nonce: string; ciphertext: string }> {
  if (!plaintext) throw new TypeError('Provider credential cannot be empty')
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12))
  if (nonce.byteLength !== 12)
    throw new TypeError('AES-GCM nonce must contain 12 bytes')
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(
        storedCredentialData(input.providerId, input.keyVersion),
      ),
      tagLength: 128,
    },
    await aesKey(resolveTaxonomyMasterKey(input.env, input.keyVersion)),
    arrayBuffer(encoder.encode(plaintext)),
  )
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
}

export function decodeEncryptionKey(value: string): Uint8Array {
  const bytes = base64UrlToBytes(value)
  if (bytes.byteLength !== 32) {
    throw new TypeError('AES-256 key must contain exactly 32 bytes')
  }
  return bytes
}

async function aesKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (key instanceof CryptoKey) {
    if (key.algorithm.name !== 'AES-GCM')
      throw new TypeError('Expected AES-GCM key')
    return key
  }
  if (key.byteLength !== 32) {
    throw new TypeError('AES-256 key must contain exactly 32 bytes')
  }
  return crypto.subtle.importKey('raw', arrayBuffer(key), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function additionalData(kid: string, context: string): Uint8Array {
  return encoder.encode(`oddweb:taxonomy-provider-key:v1:${kid}:${context}`)
}

export async function encryptProviderKey(
  plaintext: string,
  key: CryptoKey | Uint8Array,
  options: { keyId: string; context?: string; iv?: Uint8Array },
): Promise<string> {
  if (!plaintext) throw new TypeError('Provider key cannot be empty')
  if (!options.keyId || options.keyId.length > 128) {
    throw new TypeError('A valid keyId is required')
  }
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(12))
  if (iv.byteLength !== 12)
    throw new TypeError('AES-GCM IV must contain 12 bytes')
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(
        additionalData(options.keyId, options.context ?? ''),
      ),
      tagLength: 128,
    },
    await aesKey(key),
    arrayBuffer(encoder.encode(plaintext)),
  )
  const envelope: ProviderKeyEnvelopeV1 = {
    v: 1,
    alg: 'A256GCM',
    kid: options.keyId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(envelope)
}

export function parseProviderKeyEnvelope(value: string): ProviderKeyEnvelopeV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('Invalid provider key envelope')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Object.keys(parsed).some(
      (key) => !['v', 'alg', 'kid', 'iv', 'ciphertext'].includes(key),
    )
  ) {
    throw new TypeError('Invalid provider key envelope')
  }
  const envelope = parsed as Partial<ProviderKeyEnvelopeV1>
  if (
    envelope.v !== 1 ||
    envelope.alg !== 'A256GCM' ||
    typeof envelope.kid !== 'string' ||
    !envelope.kid ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new TypeError('Unsupported provider key envelope')
  }
  if (base64UrlToBytes(envelope.iv).byteLength !== 12) {
    throw new TypeError('Invalid provider key envelope IV')
  }
  return envelope as ProviderKeyEnvelopeV1
}

export async function decryptProviderKey(
  value: string,
  resolveKey: (
    keyId: string,
  ) => CryptoKey | Uint8Array | Promise<CryptoKey | Uint8Array>,
  options: { context?: string } = {},
): Promise<string> {
  const envelope = parseProviderKeyEnvelope(value)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(base64UrlToBytes(envelope.iv)),
        additionalData: arrayBuffer(
          additionalData(envelope.kid, options.context ?? ''),
        ),
        tagLength: 128,
      },
      await aesKey(await resolveKey(envelope.kid)),
      arrayBuffer(base64UrlToBytes(envelope.ciphertext)),
    )
    return decoder.decode(plaintext)
  } catch {
    throw new Error('Unable to decrypt provider key')
  }
}
