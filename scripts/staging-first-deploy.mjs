import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requiredSecrets = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_SECRET',
  'TAXONOMY_MASTER_KEY_V1',
]

export function runFirstStagingDeploy(options = {}) {
  const root =
    options.root ??
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
  const env = options.env ?? process.env
  const io = options.io ?? systemIo(root)
  const secretsFile = validateSecretsFile(root, env.STAGING_SECRETS_FILE, io)
  validateBootstrapSecrets(io.read(secretsFile, 'utf8'), secretsFile)

  io.run('npm', ['run', 'staging:verify'])
  assertCleanSource(io)

  const configPath = resolve(root, '.wrangler/staging.jsonc')
  const config = readConfig(io, configPath)
  const database = config.d1_databases?.find(
    (binding) => binding.binding === 'DB',
  )?.database_name
  const releaseSha = config.vars?.RELEASE_SHA
  if (!database || !releaseSha) {
    throw new Error(
      'Generated staging config is missing DB or release metadata.',
    )
  }

  const artifactPaths = [
    configPath,
    resolve(root, 'dist/server'),
    resolve(root, 'dist/client'),
    secretsFile,
  ]
  const artifactDigest = io.hash(artifactPaths)
  const deployArgs = [
    'wrangler',
    'deploy',
    '--config',
    configPath,
    '--strict',
    '--secrets-file',
    secretsFile,
  ]
  io.run('npx', [...deployArgs, '--dry-run'])

  assertFirstDeployTargetAbsent(io, config, configPath)

  io.run('npx', [
    'wrangler',
    'd1',
    'migrations',
    'list',
    database,
    '--remote',
    '--config',
    configPath,
  ])
  assertCleanSource(io)
  assertArtifactUnchanged(io, artifactPaths, artifactDigest)
  io.run('npx', [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    database,
    '--remote',
    '--config',
    configPath,
  ])
  assertCleanSource(io)
  assertArtifactUnchanged(io, artifactPaths, artifactDigest)
  io.run('npx', deployArgs)
  io.run('npm', ['run', 'staging:postdeploy'])
  io.run('npm', ['run', 'staging:smoke'], {
    ...env,
    RELEASE_SHA: releaseSha,
  })
}

function assertFirstDeployTargetAbsent(io, config, configPath) {
  let deployment
  try {
    deployment = io.output('npx', [
      'wrangler',
      'deployments',
      'status',
      '--json',
      '--config',
      configPath,
    ])
  } catch (error) {
    if (!isMissingWorkerError(error)) {
      throw new Error(
        `Could not prove Worker ${config.name} is undeployed before first-deploy migrations.`,
        { cause: error },
      )
    }
  }
  if (deployment !== undefined) {
    const parsed = JSON.parse(deployment)
    if ((parsed.versions ?? []).length > 0 || parsed.id || parsed.version_id) {
      throw new Error(
        `Worker ${config.name} already has a deployment; refusing first-deploy migrations.`,
      )
    }
    throw new Error(
      `Could not prove Worker ${config.name} is undeployed before first-deploy migrations.`,
    )
  }
  for (const consumer of config.queues?.consumers ?? []) {
    const deployed = JSON.parse(
      io.output('npx', [
        'wrangler',
        'queues',
        'consumer',
        'worker',
        'list',
        consumer.queue,
        '--json',
        '--config',
        configPath,
      ]),
    )
    if (
      deployed.some((entry) =>
        [entry.script, entry.service, entry.script_name].includes(config.name),
      )
    ) {
      throw new Error(
        `Queue ${consumer.queue} already has consumer ${config.name}; refusing first-deploy migrations.`,
      )
    }
  }
}

function isMissingWorkerError(error) {
  return (
    error instanceof Error &&
    /(?:worker|script|service).*(?:not found|does not exist)|10090/i.test(
      `${error.message} ${String(error.cause ?? '')}`,
    )
  )
}

export function parseSecretsFile(source, path = '') {
  if (path.endsWith('.json') || source.trimStart().startsWith('{')) {
    const parsed = JSON.parse(source)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('The staging secrets JSON must contain an object.')
    }
    return parsed
  }
  const values = {}
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = assignment.indexOf('=')
    if (separator < 1) {
      throw new Error(
        'The staging secrets file contains an invalid assignment.',
      )
    }
    const key = assignment.slice(0, separator).trim()
    let value = assignment.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export function validateBootstrapSecrets(source, path = '') {
  const secrets = parseSecretsFile(source, path)
  const missing = requiredSecrets.filter(
    (name) => typeof secrets[name] !== 'string' || !secrets[name].trim(),
  )
  if (missing.length) {
    throw new Error(
      `STAGING_SECRETS_FILE is missing required keys: ${missing.join(', ')}.`,
    )
  }
  if (!parsePasswordHash(secrets.ADMIN_PASSWORD_HASH)) {
    throw new Error(
      'ADMIN_PASSWORD_HASH must use $pbkdf2-sha256$100000$<base64url-salt>$<base64url-32-byte-hash> with at least 16 salt bytes.',
    )
  }
  if (secrets.ADMIN_SESSION_SECRET.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters.')
  }
  if (!isBase64UrlBytes(secrets.TAXONOMY_MASTER_KEY_V1, 32)) {
    throw new Error(
      'TAXONOMY_MASTER_KEY_V1 must be unpadded base64url encoding exactly 32 bytes.',
    )
  }
  return secrets
}

function parsePasswordHash(value) {
  const match =
    /^\$pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(value)
  if (!match || Number(match[1]) !== 100_000) return null
  const salt = decodeBase64Url(match[2])
  const hash = decodeBase64Url(match[3])
  return salt?.byteLength >= 16 && hash?.byteLength === 32
    ? { iterations: 100_000, salt, hash }
    : null
}

function isBase64UrlBytes(value, bytes) {
  return decodeBase64Url(value)?.byteLength === bytes
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.toString('base64url') === value ? decoded : null
  } catch {
    return null
  }
}

function validateSecretsFile(root, input, io) {
  if (!input || !isAbsolute(input)) {
    throw new Error(
      'Set STAGING_SECRETS_FILE to an absolute .env or JSON file outside the repository.',
    )
  }
  const secretsFile = io.realpath(input)
  const relativeSecrets = relative(root, secretsFile)
  if (
    relativeSecrets === '' ||
    (!relativeSecrets.startsWith('..') && !isAbsolute(relativeSecrets))
  ) {
    throw new Error('STAGING_SECRETS_FILE must be outside the repository.')
  }
  const stats = io.stat(secretsFile)
  if (!stats.isFile()) {
    throw new Error('STAGING_SECRETS_FILE must be a regular file.')
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      'STAGING_SECRETS_FILE must not be accessible by group or other users.',
    )
  }
  return secretsFile
}

function assertCleanSource(io) {
  if (io.output('git', ['status', '--porcelain'])) {
    throw new Error(
      'The first staging deployment requires a clean Git worktree after verification.',
    )
  }
}

function assertArtifactUnchanged(io, paths, digest) {
  if (io.hash(paths) !== digest) {
    throw new Error(
      'The verified staging config, build, or secrets changed before remote mutation.',
    )
  }
}

function readConfig(io, path) {
  return JSON.parse(io.read(path, 'utf8'))
}

function systemIo(root) {
  return {
    run(command, args, env = process.env) {
      execFileSync(command, args, { cwd: root, env, stdio: 'inherit' })
    },
    output(command, args) {
      return execFileSync(command, args, {
        cwd: root,
        encoding: 'utf8',
      }).trim()
    },
    read: readFileSync,
    realpath: realpathSync,
    stat: statSync,
    hash: hashPaths,
  }
}

function hashPaths(paths) {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) hashPath(hash, path, path)
  return hash.digest('hex')
}

function hashPath(hash, root, path) {
  const stats = statSync(path)
  hash.update(`${stats.isDirectory() ? 'd' : 'f'}:${relative(root, path)}\0`)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      hashPath(hash, root, resolve(path, entry))
    }
    return
  }
  hash.update(readFileSync(path))
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runFirstStagingDeploy()
