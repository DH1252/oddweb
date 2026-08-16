import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const productionTaxonomyResources = {
  queue: 'oddweb-taxonomy',
  dlq: 'oddweb-taxonomy-dlq',
}

export function readJsonc(path) {
  return parseJsonc(readFileSync(path, 'utf8'))
}

export function parseJsonc(source) {
  let withoutComments = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (inString) {
      withoutComments += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      withoutComments += character
      continue
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      withoutComments += '\n'
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') withoutComments += '\n'
        index += 1
      }
      index += 1
      continue
    }
    withoutComments += character
  }

  let json = ''
  inString = false
  escaped = false
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]
    if (inString) {
      json += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      json += character
      continue
    }
    if (character === ',') {
      let next = index + 1
      while (/\s/.test(withoutComments[next] ?? '')) next += 1
      if (withoutComments[next] === '}' || withoutComments[next] === ']')
        continue
    }
    json += character
  }
  return JSON.parse(json)
}

export function validateQueueConsumerSettings(configured, deployed) {
  const failures = []
  const settings = deployed?.settings ?? {}
  const comparisons = [
    ['max_batch_size', 'batch_size', 1],
    ['max_batch_timeout', 'max_wait_time_ms', 1000],
    ['max_retries', 'max_retries', 1],
    ['max_concurrency', 'max_concurrency', 1],
    ['retry_delay', 'retry_delay', 1],
  ]
  for (const [configKey, remoteKey, multiplier] of comparisons) {
    if (configured?.[configKey] === undefined) {
      const automatic =
        settings[remoteKey] === undefined ||
        settings[remoteKey] === null ||
        (configKey === 'retry_delay' && Number(settings[remoteKey]) === 0)
      if (
        ['max_concurrency', 'retry_delay'].includes(configKey) &&
        !automatic
      ) {
        failures.push(
          `${configKey} is ${String(settings[remoteKey])}, expected automatic/default`,
        )
      }
      continue
    }
    const expected = Number(configured[configKey]) * multiplier
    if (Number(settings[remoteKey]) !== expected) {
      failures.push(
        `${configKey} is ${String(settings[remoteKey])}, expected ${expected}`,
      )
    }
  }
  return failures
}

export function taxonomyResources(config) {
  const database = config.d1_databases?.find(
    (candidate) => candidate.binding === 'DB',
  )
  const thumbnails = config.r2_buckets?.find(
    (candidate) => candidate.binding === 'THUMBNAILS',
  )
  return {
    worker: config.name,
    database: database?.database_name,
    databaseId: database?.database_id,
    bucket: thumbnails?.bucket_name,
  }
}

export function validateTaxonomyConfig(config, expected) {
  const failures = []
  const producer = (config.queues?.producers ?? []).find(
    (candidate) => candidate.binding === 'TAXONOMY_QUEUE',
  )
  const consumer = (config.queues?.consumers ?? []).find(
    (candidate) => candidate.queue === expected.queue,
  )
  if (producer?.queue !== expected.queue)
    failures.push(
      `TAXONOMY_QUEUE must produce to the explicit queue ${expected.queue}`,
    )
  if (!consumer) failures.push(`a consumer for ${expected.queue} is required`)
  else {
    if (consumer.dead_letter_queue !== expected.dlq)
      failures.push(`the taxonomy consumer DLQ must be ${expected.dlq}`)
    if (!Number.isInteger(consumer.max_retries) || consumer.max_retries < 1)
      failures.push('the taxonomy consumer must configure at least one retry')
  }
  if (!config.triggers?.crons?.includes('*/5 * * * *'))
    failures.push('the taxonomy maintenance cron must run every five minutes')
  if (!config.secrets?.required?.includes('TAXONOMY_MASTER_KEY_V1'))
    failures.push(
      'TAXONOMY_MASTER_KEY_V1 must be declared as a required secret',
    )
  if (Object.hasOwn(config.vars ?? {}, 'TAXONOMY_MASTER_KEY_V1'))
    failures.push('TAXONOMY_MASTER_KEY_V1 must not be stored in vars')
  if (expected.queue === expected.dlq)
    failures.push('the taxonomy queue and DLQ must be distinct')
  const resources = taxonomyResources(config)
  if (!resources.worker) failures.push('the Worker name is required')
  if (!resources.database || !resources.databaseId)
    failures.push('the DB binding must declare a D1 database name and ID')
  if (!resources.bucket)
    failures.push('the THUMBNAILS binding must declare an R2 bucket name')
  return failures
}

export function remoteResourcePreflight(
  configPath,
  config,
  expected,
  execute = exec,
) {
  const failures = []
  const warnings = []
  const resources = taxonomyResources(config)
  if (!remoteAuthenticated(execute, failures)) return { failures, warnings }

  remoteOutput(
    execute,
    ['queues', 'info', expected.queue, '--config', configPath],
    failures,
    `producer queue ${expected.queue}`,
  )
  remoteOutput(
    execute,
    ['queues', 'info', expected.dlq, '--config', configPath],
    failures,
    `dead-letter queue ${expected.dlq}`,
  )

  const d1Output = remoteOutput(
    execute,
    ['d1', 'info', resources.database, '--config', configPath, '--json'],
    failures,
    `D1 database ${resources.database}`,
  )
  if (d1Output) {
    const d1 = JSON.parse(d1Output)
    if (d1.uuid !== resources.databaseId)
      failures.push(
        `remote D1 ${resources.database} has ID ${d1.uuid}, expected ${resources.databaseId}`,
      )
    remoteOutput(
      execute,
      [
        'd1',
        'execute',
        resources.database,
        '--config',
        configPath,
        '--remote',
        '--json',
        '--command',
        'SELECT 1 AS ok',
      ],
      failures,
      'read-only taxonomy_state query',
    )
  }

  remoteOutput(
    execute,
    ['r2', 'bucket', 'info', resources.bucket, '--config', configPath],
    failures,
    `R2 bucket ${resources.bucket}`,
  )

  return { failures, warnings }
}

export function remoteHandlerValidation(
  configPath,
  config,
  expected,
  execute = exec,
) {
  const failures = []
  const warnings = []
  const resources = taxonomyResources(config)
  if (!remoteAuthenticated(execute, failures)) return { failures, warnings }

  const consumerOutput = remoteOutput(
    execute,
    [
      'queues',
      'consumer',
      'worker',
      'list',
      expected.queue,
      '--json',
      '--config',
      configPath,
    ],
    failures,
    `worker consumers for queue ${expected.queue}`,
  )
  if (consumerOutput) {
    const consumers = JSON.parse(consumerOutput)
    const consumer = consumers.find(
      (candidate) =>
        candidate.script === resources.worker ||
        candidate.service === resources.worker ||
        candidate.script_name === resources.worker,
    )
    if (!consumer)
      failures.push(
        `remote queue ${expected.queue} does not expose consumer ${resources.worker}`,
      )
    else {
      if (consumer.dead_letter_queue !== expected.dlq)
        failures.push(
          `remote queue ${expected.queue} consumer ${resources.worker} does not use DLQ ${expected.dlq}`,
        )
      const configuredConsumer = config.queues?.consumers?.find(
        (candidate) => candidate.queue === expected.queue,
      )
      for (const failure of validateQueueConsumerSettings(
        configuredConsumer,
        consumer,
      )) {
        failures.push(
          `remote queue ${expected.queue} consumer ${resources.worker} ${failure}`,
        )
      }
    }
  }

  const secretOutput = remoteOutput(
    execute,
    [
      'secret',
      'list',
      '--config',
      configPath,
      '--name',
      resources.worker,
      '--format',
      'json',
    ],
    failures,
    `secret metadata for Worker ${resources.worker}`,
  )
  if (secretOutput) {
    const remoteSecrets = new Set(
      JSON.parse(secretOutput).map((secret) => secret.name),
    )
    for (const requiredSecret of config.secrets?.required ?? []) {
      if (!remoteSecrets.has(requiredSecret)) {
        failures.push(
          `remote Worker ${resources.worker} is missing ${requiredSecret} secret metadata`,
        )
      }
    }
  }

  const deploymentOutput = remoteOutput(
    execute,
    [
      'deployments',
      'status',
      '--config',
      configPath,
      '--name',
      resources.worker,
      '--json',
    ],
    failures,
    `deployment metadata for Worker ${resources.worker}`,
  )
  if (deploymentOutput) {
    const deployment = JSON.parse(deploymentOutput)
    const activeVersions = deployment.versions?.filter(
      (version) => Number(version.percentage) === 100,
    )
    const activeVersion =
      activeVersions?.length === 1 ? activeVersions[0].version_id : undefined
    if (!activeVersion)
      failures.push(
        `Worker ${resources.worker} does not have exactly one 100% active deployed version`,
      )
    else {
      const versionOutput = remoteOutput(
        execute,
        [
          'versions',
          'view',
          activeVersion,
          '--name',
          resources.worker,
          '--json',
        ],
        failures,
        `active version metadata for Worker ${resources.worker}`,
      )
      if (versionOutput) {
        const version = JSON.parse(versionOutput)
        const handlers = new Set(version.resources?.script?.handlers ?? [])
        for (const handler of ['fetch', 'queue', 'scheduled'])
          if (!handlers.has(handler))
            failures.push(
              `active Worker ${resources.worker} does not expose the ${handler} handler`,
            )
        const bindings = version.resources?.bindings ?? []
        if (
          !bindings.some(
            (binding) =>
              binding.name === 'DB' &&
              (binding.database_id === resources.databaseId ||
                binding.id === resources.databaseId),
          )
        )
          failures.push(
            'active Worker does not expose the configured DB binding',
          )
        if (
          !bindings.some(
            (binding) =>
              binding.name === 'TAXONOMY_QUEUE' &&
              (binding.queue_name === expected.queue ||
                binding.queue === expected.queue),
          )
        )
          failures.push(
            'active Worker does not expose the configured TAXONOMY_QUEUE binding',
          )
        if (
          !bindings.some(
            (binding) =>
              binding.name === 'THUMBNAILS' &&
              binding.bucket_name === resources.bucket,
          )
        )
          failures.push(
            'active Worker does not expose the configured THUMBNAILS binding',
          )
      }
    }
  }
  warnings.push(
    'Wrangler exposes the deployed scheduled handler but has no read-only command for deployed cron schedules; the post-deploy outbox probe verifies cron execution.',
  )
  return { failures, warnings }
}

export function remotePreflight(configPath, config, expected, execute = exec) {
  const resources = remoteResourcePreflight(
    configPath,
    config,
    expected,
    execute,
  )
  if (resources.failures.length) return resources
  const handlers = remoteHandlerValidation(
    configPath,
    config,
    expected,
    execute,
  )
  return {
    failures: [...resources.failures, ...handlers.failures],
    warnings: [...resources.warnings, ...handlers.warnings],
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const configPath = resolve(option('--config') ?? 'wrangler.jsonc')
  const expected = {
    queue: option('--queue') ?? productionTaxonomyResources.queue,
    dlq: option('--dlq') ?? productionTaxonomyResources.dlq,
  }
  const config = readJsonc(configPath)
  const failures = validateTaxonomyConfig(config, expected)
  const warnings = []
  const allRemote = process.argv.includes('--remote')
  const checkRemoteResources =
    allRemote || process.argv.includes('--remote-resources')
  const checkRemoteHandlers =
    allRemote || process.argv.includes('--remote-handlers')
  if (failures.length === 0 && checkRemoteResources) {
    const remote = remoteResourcePreflight(configPath, config, expected)
    failures.push(...remote.failures)
    warnings.push(...remote.warnings)
  }
  if (failures.length === 0 && checkRemoteHandlers) {
    const remote = remoteHandlerValidation(configPath, config, expected)
    failures.push(...remote.failures)
    warnings.push(...remote.warnings)
  }
  for (const warning of warnings) console.warn(`Warning: ${warning}`)
  if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join('\n'))
    console.error(
      '\nResources are never created by release. Provision them only after explicit approval, for example with `wrangler queues create <name>` and `wrangler secret put TAXONOMY_MASTER_KEY_V1`.',
    )
    process.exit(1)
  }
  const scope = [
    'configuration',
    ...(checkRemoteResources ? ['remote resources'] : []),
    ...(checkRemoteHandlers ? ['deployed handlers'] : []),
  ].join(', ')
  console.log(`Taxonomy ${scope} passed preflight.`)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function remoteOutput(execute, args, failures, label) {
  try {
    return execute('wrangler', args)
  } catch {
    failures.push(`remote ${label} is missing, inaccessible, or invalid`)
    return ''
  }
}

function remoteAuthenticated(execute, failures) {
  try {
    execute('wrangler', ['whoami'])
    return true
  } catch {
    failures.push(
      'Cloudflare authentication is unavailable; authenticate with `wrangler login` or provide a valid API token before release',
    )
    return false
  }
}

function exec(command, args) {
  return execFileSync('npx', [command, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
