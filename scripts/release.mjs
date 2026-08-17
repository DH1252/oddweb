import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseJsonc,
  productionTaxonomyResources,
  readJsonc,
  validateQueueConsumerSettings,
} from './check-taxonomy-resources.mjs'

const database = 'oddweb'
const migrationNamePattern = /\b\d{4}_[A-Za-z0-9_-]+\.sql\b/g
const drainIntervalMs = 5_000
const drainAttempts = 253
const sustainedDrainSamples = 3
const taxonomyExecutionWindowSeconds = 20 * 60
const maintenanceBarrierKey = 'release:maintenance'
const releaseLeaseKey = 'release:lease'
const releaseInvocationPrefix = 'release:invocation:'
const releaseLeaseSeconds = 2 * 60 * 60

export function runRelease(options = {}) {
  const root =
    options.root ??
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
    }).trim()
  const env = options.env ?? process.env
  let io = options.io ?? systemIo(root)
  io = { ...io, queueStateEnv: env }
  const baseIo = io
  const now = options.now ?? (() => new Date())
  const triggerConfigPath = resolve(root, 'wrangler.jsonc')
  const config = options.config ?? readJsonc(triggerConfigPath)

  io.run('npm', ['run', 'release:check'])
  io.run('npm', ['run', 'verify'])
  // Route generation is part of verify and may change tracked files.
  io.run('npm', ['run', 'release:check'])
  io.run('npm', ['run', 'taxonomy:preflight:remote'])

  const backupDir = validateBackupDirectory(root, env.BACKUP_DIR, io)
  const sha = io.output('git', ['rev-parse', 'HEAD']).trim()
  const releasedAt = now().toISOString()
  const timestamp = releasedAt.replaceAll(/[:.]/g, '-')
  const tag = `release-${sha.slice(0, 12)}-${timestamp}`
  const message = `Oddweb ${sha} ${releasedAt}`

  const pendingD1Migrations = parsePendingD1Migrations(
    io.output('npx', [
      'wrangler',
      'd1',
      'migrations',
      'list',
      database,
      '--remote',
    ]),
  )
  const contractMigrations = pendingD1Migrations.filter((name) =>
    io
      .read(resolve(root, 'drizzle', name), 'utf8')
      .includes('release: maintenance-required'),
  )
  const releaseLease = acquireReleaseLease(
    baseIo,
    resolve(root, 'wrangler.jsonc'),
    randomUUID(),
    now,
  )
  io = releaseOwnedIo(baseIo, releaseLease, now)
  try {
    const previousVersion = currentVersionId(io)
    const previousVersionMetadata = JSON.parse(
      io.output('npx', [
        'wrangler',
        'versions',
        'view',
        previousVersion,
        '--json',
      ]),
    )
    const previousMigrationTag = durableObjectMigrationTag(
      previousVersionMetadata,
    )
    const previousReleaseSha = workerReleaseSha(previousVersionMetadata)
    const previousReleaseTime = workerReleaseTime(previousVersionMetadata)
    const previousReleaseFenceVersion = workerReleaseFenceVersion(
      previousVersionMetadata,
    )
    const previousMaintenanceActive = workerMaintenanceMode(
      previousVersionMetadata,
    )
    const previousConfig =
      options.previousConfig ?? loadPreviousConfig(io, previousReleaseSha)
    const activeRoutes = structuredClone(previousConfig.routes ?? [])
    const pendingLifecycleMigrations = pendingDurableObjectMigrations(
      config.migrations ?? [],
      previousMigrationTag,
    )
    const databaseMigrationPending = pendingD1Migrations.length > 0
    const lifecycleMigrationPending = pendingLifecycleMigrations.length > 0
    const maintenanceRequired =
      databaseMigrationPending ||
      lifecycleMigrationPending ||
      previousMaintenanceActive
    if (maintenanceRequired && previousReleaseFenceVersion !== '1') {
      throw new Error(
        'The active Worker does not support release fence version 1. Deploy this revision once without pending D1 or Durable Object migrations before attempting a migration release.',
      )
    }

    const generatedDir = resolve(root, '.wrangler')
    const generatedBuildConfigPath = resolve(root, 'dist/server/wrangler.json')
    const generatedBuildConfig = JSON.parse(
      io.read(generatedBuildConfigPath, 'utf8'),
    )
    const artifactDir = resolve(
      generatedDir,
      `release-artifact-${sha.slice(0, 12)}-${timestamp}`,
    )
    const artifactServerDir = resolve(artifactDir, 'server')
    const artifactClientDir = resolve(artifactDir, 'client')
    const artifactMaintenancePath = resolve(
      artifactDir,
      'maintenance-worker.mjs',
    )
    const productionConfigPath = resolve(generatedDir, 'production.jsonc')
    const releaseConfigPath = resolve(generatedDir, 'release.jsonc')
    const maintenanceConfigPath = resolve(generatedDir, 'maintenance.jsonc')
    const previousTriggersConfigPath = resolve(
      generatedDir,
      'previous-triggers.jsonc',
    )
    io.mkdir(generatedDir)
    io.copy(resolve(root, 'dist/server'), artifactServerDir)
    io.copy(resolve(root, 'dist/client'), artifactClientDir)
    io.copy(
      resolve(root, 'scripts/maintenance-worker.mjs'),
      artifactMaintenancePath,
    )

    const artifactPaths = {
      sourceConfigPath: generatedBuildConfigPath,
      targetConfigPath: productionConfigPath,
      mappings: [
        { from: resolve(root, 'dist/server'), to: artifactServerDir },
        { from: resolve(root, 'dist/client'), to: artifactClientDir },
      ],
    }
    const productionConfig = buildVerifiedArtifactConfig(
      generatedBuildConfig,
      artifactPaths,
    )
    const releaseConfig = buildTriggerDeferredConfig(generatedBuildConfig, {
      ...artifactPaths,
      targetConfigPath: releaseConfigPath,
    })
    const maintenanceConfig = buildMaintenanceConfig(
      config,
      previousMigrationTag,
      {
        routes: activeRoutes,
        main: rebaseAbsolutePath(
          artifactMaintenancePath,
          maintenanceConfigPath,
        ),
        releaseSha: previousReleaseSha,
        releaseTime: previousReleaseTime,
        releaseFenceVersion: previousReleaseFenceVersion,
      },
    )
    writeConfig(io, productionConfigPath, productionConfig)
    writeConfig(io, releaseConfigPath, releaseConfig)
    writeConfig(io, maintenanceConfigPath, maintenanceConfig)

    dryRunApplication(io, productionConfigPath)
    if (lifecycleMigrationPending) dryRunApplication(io, releaseConfigPath)
    dryRunApplication(io, maintenanceConfigPath)
    const candidateQueueNames = releaseQueueNames(
      config,
      previousConfig,
      previousVersionMetadata,
    )
    const priorQueueConsumers = snapshotQueueConsumers(
      io,
      candidateQueueNames,
      config.name,
      productionConfigPath,
    )
    const previousRestoreConfig = buildTriggerConfig(previousConfig, {
      consumers: snapshotConsumersToConfig(priorQueueConsumers),
    })
    writeConfig(io, previousTriggersConfigPath, previousRestoreConfig)
    dryRunTriggers(io, previousTriggersConfigPath)
    const initialQueueDelivery = queryQueueDeliveryState(io, env)
    const initialQueueDeliveryState = initialQueueDelivery.state

    const maintenanceConfigPaths = new Map()
    maintenanceConfigPaths.set(
      previousMigrationTag ?? '',
      maintenanceConfigPath,
    )
    for (const migration of config.migrations ?? []) {
      if (maintenanceConfigPaths.has(migration.tag)) continue
      const path = resolve(
        generatedDir,
        `maintenance-${safeConfigName(migration.tag)}.jsonc`,
      )
      writeConfig(
        io,
        path,
        buildMaintenanceConfig(config, migration.tag, {
          routes: activeRoutes,
          main: rebaseAbsolutePath(artifactMaintenancePath, path),
          releaseSha: previousReleaseSha,
          releaseTime: previousReleaseTime,
          releaseFenceVersion: previousReleaseFenceVersion,
        }),
      )
      dryRunApplication(io, path)
      maintenanceConfigPaths.set(migration.tag, path)
    }

    const artifactHashPaths = [
      artifactDir,
      productionConfigPath,
      releaseConfigPath,
      previousTriggersConfigPath,
      ...new Set(maintenanceConfigPaths.values()),
    ]
    const artifactDigest = io.hash(artifactHashPaths)

    const backupPath = databaseMigrationPending
      ? resolve(backupDir, `oddweb-${timestamp}-${sha.slice(0, 12)}.sql`)
      : undefined
    const recoveryPath = backupPath
      ? `${backupPath}.json`
      : resolve(
          backupDir,
          `oddweb-${timestamp}-${sha.slice(0, 12)}.recovery.json`,
        )
    const journal = {
      schemaVersion: 1,
      database,
      databaseId: config.d1_databases?.find(
        (binding) => binding.binding === 'DB',
      )?.database_id,
      strategy: recoveryStrategy(
        databaseMigrationPending,
        lifecycleMigrationPending,
      ),
      releaseSha: sha,
      releaseTag: tag,
      releasedAt,
      previousWorkerVersion: previousVersion,
      previousReleaseSha: previousReleaseSha ?? null,
      previousMaintenanceActive,
      previousReleaseFenceVersion: previousReleaseFenceVersion ?? null,
      previousDurableObjectMigrationTag: previousMigrationTag ?? null,
      pendingD1Migrations,
      contractMigrations,
      pendingDurableObjectMigrations: pendingLifecycleMigrations.map(
        (migration) => migration.tag,
      ),
      queue: productionTaxonomyResources.queue,
      initialQueueDeliveryState,
      priorQueueConsumers,
      artifact: {
        digest: artifactDigest,
        directory: artifactDir,
        productionConfigPath,
        releaseConfigPath,
        maintenanceConfigPaths: Object.fromEntries(maintenanceConfigPaths),
        previousTriggersConfigPath,
      },
      ...(backupPath ? { backupPath } : {}),
      phaseHistory: [],
    }
    updateJournal(io, recoveryPath, journal, 'prepared', now)

    // This is intentionally adjacent to the first remote mutation. It catches
    // route generation, verification, or concurrent source changes made since
    // the earlier release checks.
    io.run('npm', ['run', 'release:check'])
    assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)

    releaseLease.configPath = productionConfigPath
    const currentQueueDelivery = queryQueueDeliveryState(io, env)
    if (
      !sameQueueDeliverySnapshot(initialQueueDelivery, currentQueueDelivery)
    ) {
      throw new Error(
        'Queue delivery state changed while the release was being prepared; refusing to infer pause ownership.',
      )
    }

    let applicationStaged = false
    if (!lifecycleMigrationPending) {
      uploadInactiveVersion(
        io,
        productionConfigPath,
        tag,
        message,
        sha,
        releasedAt,
      )
      applicationStaged = true
      updateJournal(io, recoveryPath, journal, 'application_staged', now)
    }

    let queuePaused = initialQueueDeliveryState === 'paused'
    let queuePauseChanged = false
    let ownedQueuePauseSnapshot
    let cronCleared = false
    try {
      if (!queuePaused) {
        ownedQueuePauseSnapshot = pauseTaxonomyDelivery(io)
        queuePaused = true
        queuePauseChanged = true
      }
      assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
      clearCronSchedules(io, maintenanceConfigPath)
      cronCleared = true
      updateJournal(io, recoveryPath, journal, 'async_triggers_paused', now, {
        queuePauseChanged,
        ...(ownedQueuePauseSnapshot ? { ownedQueuePauseSnapshot } : {}),
      })
    } catch (error) {
      const containmentErrors = []
      containmentErrors.push(
        ...restoreTriggerAndQueueState({
          io,
          desiredConfig: previousRestoreConfig,
          configPath: previousTriggersConfigPath,
          candidateQueueNames,
          resume: queuePauseChanged,
          ownedQueuePauseSnapshot,
          artifactHashPaths,
          artifactDigest,
        }),
      )
      recordFailure(
        io,
        recoveryPath,
        journal,
        'pause_or_cron_clear_failed',
        error,
        containmentErrors,
        now,
      )
      io.error(
        'Queue pause or cron clearing failed before application promotion. Previous trigger configuration and queue delivery were restored where possible.',
      )
      throwWithContainment(error, containmentErrors)
    }

    let maintenanceActive = false
    if (maintenanceRequired) {
      try {
        if (!queuePaused || !cronCleared) {
          throw new Error(
            'Maintenance requires confirmed queue pause and cron clearing.',
          )
        }
        assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
        deployMaintenance(io, maintenanceConfigPath, `${message} maintenance`)
        maintenanceActive = true
        updateJournal(io, recoveryPath, journal, 'maintenance_active', now)
        setMaintenanceBarrier(io, productionConfigPath)
        updateJournal(
          io,
          recoveryPath,
          journal,
          'maintenance_barrier_set',
          now,
          {
            maintenanceBarrier: true,
          },
        )
        updateJournal(io, recoveryPath, journal, 'write_drain_started', now)
        const drain = drainReleaseActivity(io, productionConfigPath)
        updateJournal(io, recoveryPath, journal, 'writes_drained', now, {
          releaseDrain: drain,
        })
      } catch (error) {
        recordFailure(
          io,
          recoveryPath,
          journal,
          'maintenance_activation_failed',
          error,
          [],
          now,
        )
        io.error(
          'Maintenance activation or taxonomy lease draining failed before database or lifecycle changes. Queue delivery remains paused and cron schedules remain cleared.',
        )
        throw error
      }
    }

    let bookmark
    try {
      bookmark = currentTimeTravelBookmark(io)
      const backupDigest = backupPath
        ? exportDatabase(io, backupPath)
        : undefined
      updateJournal(io, recoveryPath, journal, 'recovery_point_created', now, {
        timeTravelBookmark: bookmark,
        ...(backupDigest ? { backupSha256: backupDigest } : {}),
      })
    } catch (error) {
      const containmentErrors = []
      if (!maintenanceActive) {
        containmentErrors.push(
          ...restoreTriggerAndQueueState({
            io,
            desiredConfig: previousRestoreConfig,
            configPath: previousTriggersConfigPath,
            candidateQueueNames,
            resume: queuePauseChanged,
            ownedQueuePauseSnapshot,
            artifactHashPaths,
            artifactDigest,
          }),
        )
      }
      recordFailure(
        io,
        recoveryPath,
        journal,
        'recovery_point_failed',
        error,
        containmentErrors,
        now,
      )
      if (maintenanceActive) {
        io.error(
          'Recovery preparation failed. Maintenance remains active with taxonomy delivery paused and cron schedules cleared; do not resume production until a recovery point has been recorded.',
        )
      }
      throwWithContainment(error, containmentErrors)
    }

    if (databaseMigrationPending) {
      try {
        io.run('npm', ['run', 'db:migrations:remote:check'])
        io.run('npm', ['run', 'db:migrate:remote'])
        updateJournal(io, recoveryPath, journal, 'migrations_applied', now)
      } catch (error) {
        recordFailure(
          io,
          recoveryPath,
          journal,
          'database_migration_failed',
          error,
          [],
          now,
        )
        io.error(
          `The database migration failed. Maintenance remains active because the previous application may no longer match the database. Inspect D1 and restore ${backupPath} or Time Travel bookmark ${bookmark} before considering the previous application.`,
        )
        throw error
      }
    } else {
      updateJournal(io, recoveryPath, journal, 'migrations_not_required', now)
    }

    let applicationDeployed = false
    try {
      if (lifecycleMigrationPending) {
        assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
        deployDirectApplication(io, releaseConfigPath, message, sha, releasedAt)
      } else {
        if (!applicationStaged) {
          throw new Error('The verified application version was not staged.')
        }
        promoteVersion(io, productionConfigPath, tag, message)
      }
      applicationDeployed = true
      updateJournal(io, recoveryPath, journal, 'application_promoted', now)
      io.run('node', ['scripts/smoke-test.mjs', '--application-only'], {
        ...env,
        RELEASE_SHA: sha,
      })
      updateJournal(io, recoveryPath, journal, 'application_verified', now)
      if (maintenanceRequired) {
        clearMaintenanceBarrier(io, productionConfigPath)
        updateJournal(
          io,
          recoveryPath,
          journal,
          'maintenance_barrier_cleared',
          now,
          { maintenanceBarrier: false },
        )
      }
    } catch (error) {
      let containmentErrors
      if (maintenanceRequired) {
        const appliedMigrationTag =
          applicationDeployed && lifecycleMigrationPending
            ? config.migrations.at(-1)?.tag
            : previousMigrationTag
        containmentErrors = holdMaintenance({
          io,
          maintenanceConfigPaths,
          migrationTag: appliedMigrationTag,
          resolveMigrationTag:
            lifecycleMigrationPending && !applicationDeployed
              ? () => activeDurableObjectMigrationTag(io)
              : undefined,
          message: `${message} application promotion or smoke test failed; maintenance remains active`,
          barrierConfigPath: productionConfigPath,
          artifactHashPaths,
          artifactDigest,
          queueAlreadyPaused: true,
          onBarrierSet: () =>
            updateJournal(
              io,
              recoveryPath,
              journal,
              'maintenance_barrier_reset',
              now,
              { maintenanceBarrier: true },
            ),
        })
        if (lifecycleMigrationPending) {
          io.error(
            'The lifecycle migration path did not pass application verification. Durable Object lifecycle changes cannot be rolled back to the previous Worker version; keep maintenance active and fix forward at the active migration tag.',
          )
        } else {
          io.error(
            `The database migration path did not pass application verification. Maintenance remains active. Use ${backupPath ?? `Time Travel bookmark ${bookmark}`} if the application cannot be fixed forward.`,
          )
        }
      } else {
        containmentErrors = restoreCodeOnlyApplication({
          io,
          previousVersion,
          message,
          previousRestoreConfig,
          previousTriggersConfigPath,
          maintenanceConfigPath,
          candidateQueueNames,
          initialQueueDeliveryState,
          ownedQueuePauseSnapshot,
          artifactHashPaths,
          artifactDigest,
        })
        io.error(
          containmentErrors.length
            ? 'Application smoke failed and one or more previous-version restoration steps failed; queue delivery and cron schedules were re-held where possible.'
            : 'Application smoke failed. The previous code, trigger configuration, queue consumer configuration, and queue delivery were restored.',
        )
      }
      recordFailure(
        io,
        recoveryPath,
        journal,
        containmentErrors.length ? 'containment_failed' : 'containment_held',
        error,
        containmentErrors,
        now,
      )
      throwWithContainment(error, containmentErrors)
    }

    try {
      assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
      deployProductionTriggers(io, root)
      reconcileQueueConsumerRemovals({
        io,
        desiredConfig: config,
        candidateQueueNames,
        configPath: triggerConfigPath,
      })
      runPostdeployValidation(io, triggerConfigPath)
      updateJournal(io, recoveryPath, journal, 'triggers_restored', now)
      if (queuePauseChanged) {
        resumeTaxonomyDelivery(io, ownedQueuePauseSnapshot)
        queuePaused = false
        updateJournal(io, recoveryPath, journal, 'queue_restored', now, {
          finalQueueDeliveryState: 'running',
        })
        io.run('node', ['scripts/smoke-test.mjs', '--triggers-only'], {
          ...env,
          RELEASE_SHA: sha,
        })
        updateJournal(io, recoveryPath, journal, 'triggers_verified', now)
      } else {
        updateJournal(
          io,
          recoveryPath,
          journal,
          'queue_preserved_paused',
          now,
          {
            finalQueueDeliveryState: 'paused',
          },
        )
        io.run(
          'node',
          ['scripts/smoke-test.mjs', '--triggers-only', '--read-only-triggers'],
          {
            ...env,
            RELEASE_SHA: sha,
            RELEASE_TAXONOMY_QUEUE_INITIAL_STATE: 'paused',
          },
        )
        updateJournal(
          io,
          recoveryPath,
          journal,
          'triggers_verified_read_only',
          now,
        )
      }
      updateJournal(
        io,
        recoveryPath,
        journal,
        queuePauseChanged ? 'completed' : 'operator_gate_queue_paused',
        now,
      )
    } catch (error) {
      const queueNeedsPause = !queuePaused
      const containmentErrors = maintenanceRequired
        ? holdMaintenance({
            io,
            maintenanceConfigPaths,
            migrationTag: lifecycleMigrationPending
              ? config.migrations.at(-1)?.tag
              : previousMigrationTag,
            message: `${message} trigger promotion or smoke test failed; maintenance remains active`,
            barrierConfigPath: productionConfigPath,
            artifactHashPaths,
            artifactDigest,
            queueAlreadyPaused: !queueNeedsPause,
            onBarrierSet: () =>
              updateJournal(
                io,
                recoveryPath,
                journal,
                'maintenance_barrier_reset',
                now,
                { maintenanceBarrier: true },
              ),
          })
        : holdAsyncDelivery(io, maintenanceConfigPath, {
            pause: queueNeedsPause,
            artifactHashPaths,
            artifactDigest,
          })
      recordFailure(
        io,
        recoveryPath,
        journal,
        containmentErrors.length ? 'containment_failed' : 'containment_held',
        error,
        containmentErrors,
        now,
      )
      io.error(
        containmentErrors.length
          ? 'Production trigger verification failed and containment was incomplete; inspect the journal and remote state before resuming delivery.'
          : maintenanceRequired
            ? 'Production trigger verification failed. Fetch maintenance is active with taxonomy delivery paused and cron schedules cleared; fix forward before resuming.'
            : 'Production trigger verification failed. The application remains deployed, but taxonomy delivery is paused and cron schedules are cleared for explicit recovery.',
      )
      throwWithContainment(error, containmentErrors)
    }

    io.log(
      queuePauseChanged
        ? `Released ${sha}. Recovery journal: ${recoveryPath}${backupPath ? `; backup: ${backupPath}` : ''}`
        : `Application and trigger deployment finished for ${sha}, but the release remains incomplete because taxonomy delivery was already paused. Resume it explicitly and run trigger-only functional verification. Recovery journal: ${recoveryPath}`,
    )
  } finally {
    releaseReleaseLease(baseIo, releaseLease, now)
  }
}

export function parsePendingD1Migrations(output) {
  return [...new Set(output.match(migrationNamePattern) ?? [])]
}

export function durableObjectMigrationTag(version) {
  return version.resources?.script_runtime?.migration_tag
}

export function pendingDurableObjectMigrations(migrations, activeTag) {
  if (migrations.length === 0) return []
  if (!activeTag) return migrations
  const activeIndex = migrations.findIndex(
    (migration) => migration.tag === activeTag,
  )
  if (activeIndex === -1) {
    throw new Error(
      `The active Durable Object migration tag ${activeTag} is not present in wrangler.jsonc; refusing to guess which lifecycle changes are pending.`,
    )
  }
  return migrations.slice(activeIndex + 1)
}

export function buildMaintenanceConfig(
  config,
  activeMigrationTag,
  options = {},
) {
  const migrations = appliedDurableObjectMigrations(
    config.migrations ?? [],
    activeMigrationTag,
  )
  return {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: config.name,
    main: options.main ?? '../scripts/maintenance-worker.mjs',
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    routes: options.routes ?? config.routes,
    vars: {
      ENVIRONMENT: 'production',
      PUBLIC_SITE_URL: 'https://oddweb.page',
      MAINTENANCE_MODE: '1',
      ...(options.releaseSha ? { RELEASE_SHA: options.releaseSha } : {}),
      ...(options.releaseTime ? { RELEASE_TIME: options.releaseTime } : {}),
      ...(options.releaseFenceVersion
        ? { RELEASE_FENCE_VERSION: options.releaseFenceVersion }
        : {}),
    },
    triggers: { crons: [] },
    ...(config.observability
      ? { observability: structuredClone(config.observability) }
      : {}),
    ...(config.logpush === undefined ? {} : { logpush: config.logpush }),
    ...(config.tail_consumers
      ? { tail_consumers: structuredClone(config.tail_consumers) }
      : {}),
    ...(config.streaming_tail_consumers
      ? {
          streaming_tail_consumers: structuredClone(
            config.streaming_tail_consumers,
          ),
        }
      : {}),
    ...(config.durable_objects
      ? { durable_objects: structuredClone(config.durable_objects) }
      : {}),
    ...(migrations.length ? { migrations } : {}),
  }
}

export function buildVerifiedArtifactConfig(config, paths) {
  const built = structuredClone(config)
  for (const key of [
    'configPath',
    'userConfigPath',
    'deployConfigPath',
    'topLevelName',
    'definedEnvironments',
  ]) {
    delete built[key]
  }
  built.$schema = rebaseAbsolutePath(
    resolve(
      dirname(paths.targetConfigPath),
      '../node_modules/wrangler/config-schema.json',
    ),
    paths.targetConfigPath,
  )
  built.main = rebaseBuildPath(config.main, paths)
  if (built.assets?.directory) {
    built.assets.directory = rebaseBuildPath(config.assets.directory, paths)
  }
  for (let index = 0; index < (built.d1_databases ?? []).length; index += 1) {
    const source = config.d1_databases[index]
    if (source?.migrations_dir) {
      built.d1_databases[index].migrations_dir = rebaseBuildPath(
        source.migrations_dir,
        paths,
      )
    }
  }
  return built
}

export function buildTriggerDeferredConfig(config, paths) {
  const deferred = buildVerifiedArtifactConfig(config, paths)
  deferred.triggers = { ...(deferred.triggers ?? {}), crons: [] }
  return deferred
}

export function buildTriggerConfig(config, options = {}) {
  const queues = structuredClone(
    config.queues ?? { producers: [], consumers: [] },
  )
  if (options.consumers) queues.consumers = structuredClone(options.consumers)
  return {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: config.name,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    workers_dev: config.workers_dev,
    preview_urls: config.preview_urls,
    routes: structuredClone(config.routes ?? []),
    triggers: structuredClone(config.triggers ?? {}),
    queues,
    workflows: structuredClone(config.workflows ?? []),
  }
}

export function drainReleaseActivity(io, configPath) {
  let latest
  let consecutiveZero = 0
  for (let attempt = 1; attempt <= drainAttempts; attempt += 1) {
    latest = queryReleaseActivity(io, configPath)
    if (latest.expiredLeasedJobs > 0 || latest.expiredLeasedOutbox > 0) {
      if (
        latest.observedAt <
        latest.latestExpiredLease + taxonomyExecutionWindowSeconds
      ) {
        consecutiveZero = 0
        if (attempt < drainAttempts) io.sleep(drainIntervalMs)
        continue
      }
    }
    if (
      latest.activeInvocations === 0 &&
      latest.activeLeasedJobs === 0 &&
      latest.activeLeasedOutbox === 0
    ) {
      consecutiveZero += 1
      if (consecutiveZero >= sustainedDrainSamples) {
        return { ...latest, attempts: attempt, consecutiveZero }
      }
    } else {
      consecutiveZero = 0
    }
    if (attempt < drainAttempts) io.sleep(drainIntervalMs)
  }
  throw new Error(
    `Mutation activity did not sustain a drain within ${Math.floor(((drainAttempts - 1) * drainIntervalMs) / 1000)} seconds: ${JSON.stringify(latest)}`,
  )
}

function queryReleaseActivity(io, configPath) {
  const output = io.output('npx', [
    'wrangler',
    'd1',
    'execute',
    database,
    '--config',
    configPath,
    '--remote',
    '--json',
    '--command',
    `SELECT
       (SELECT count(*) FROM app_state
        WHERE key LIKE '${releaseInvocationPrefix}%'
          AND json_extract(value, '$.expiresAt') > unixepoch()) AS active_invocations,
       (SELECT count(*) FROM taxonomy_jobs
         WHERE status = 'leased' AND leased_until >= unixepoch()) AS active_leased_jobs,
       (SELECT count(*) FROM taxonomy_jobs
        WHERE status = 'leased' AND leased_until < unixepoch()) AS expired_leased_jobs,
       (SELECT count(*) FROM taxonomy_outbox
         WHERE lease_token IS NOT NULL AND leased_until >= unixepoch()) AS active_leased_outbox,
       (SELECT count(*) FROM taxonomy_outbox
        WHERE lease_token IS NOT NULL AND leased_until < unixepoch()) AS expired_leased_outbox,
       max(
         coalesce((SELECT max(leased_until) FROM taxonomy_jobs
                   WHERE status = 'leased' AND leased_until < unixepoch()), 0),
         coalesce((SELECT max(leased_until) FROM taxonomy_outbox
                   WHERE lease_token IS NOT NULL AND leased_until < unixepoch()), 0)
       ) AS latest_expired_lease,
       unixepoch() AS observed_at`,
  ])
  const parsed = JSON.parse(output)
  const statement = Array.isArray(parsed) ? parsed[0] : parsed
  const row = statement?.results?.[0]
  if (!statement?.success || !row) {
    throw new Error('Could not read active taxonomy lease counts from D1.')
  }
  return {
    activeInvocations: Number(row.active_invocations),
    activeLeasedJobs: Number(row.active_leased_jobs),
    expiredLeasedJobs: Number(row.expired_leased_jobs),
    activeLeasedOutbox: Number(row.active_leased_outbox),
    expiredLeasedOutbox: Number(row.expired_leased_outbox),
    latestExpiredLease: Number(row.latest_expired_lease),
    observedAt: Number(row.observed_at),
  }
}

function validateBackupDirectory(root, input, io) {
  if (!input || !isAbsolute(input)) {
    throw new Error(
      'Set BACKUP_DIR to an absolute recovery directory outside the repository.',
    )
  }
  const unresolvedRelative = relative(root, input)
  if (
    unresolvedRelative === '' ||
    (!unresolvedRelative.startsWith('..') && !isAbsolute(unresolvedRelative))
  ) {
    throw new Error('BACKUP_DIR must be outside the repository.')
  }
  io.mkdir(input)
  const backupDir = io.realpath(input)
  const relativeBackup = relative(root, backupDir)
  if (
    relativeBackup === '' ||
    (!relativeBackup.startsWith('..') && !isAbsolute(relativeBackup))
  ) {
    throw new Error('BACKUP_DIR must be outside the repository.')
  }
  return backupDir
}

function currentVersionId(io) {
  const deployment = JSON.parse(
    io.output('npx', ['wrangler', 'deployments', 'status', '--json']),
  )
  const active = deployment.versions?.filter(
    (version) => Number(version.percentage) === 100,
  )
  if (active?.length !== 1 || !active[0].version_id) {
    throw new Error('Could not determine the current 100% Worker version.')
  }
  return active[0].version_id
}

function currentTimeTravelBookmark(io) {
  const result = JSON.parse(
    io.output('npx', [
      'wrangler',
      'd1',
      'time-travel',
      'info',
      database,
      '--json',
    ]),
  )
  if (!result.bookmark) {
    throw new Error('Wrangler did not return a D1 Time Travel bookmark.')
  }
  return result.bookmark
}

function activeDurableObjectMigrationTag(io) {
  const version = currentVersionId(io)
  const metadata = JSON.parse(
    io.output('npx', ['wrangler', 'versions', 'view', version, '--json']),
  )
  return durableObjectMigrationTag(metadata)
}

function workerReleaseSha(version) {
  return version.resources?.bindings?.find(
    (binding) =>
      binding.name === 'RELEASE_SHA' && binding.type === 'plain_text',
  )?.text
}

function workerReleaseTime(version) {
  return version.resources?.bindings?.find(
    (binding) =>
      binding.name === 'RELEASE_TIME' && binding.type === 'plain_text',
  )?.text
}

function workerReleaseFenceVersion(version) {
  return version.resources?.bindings?.find(
    (binding) =>
      binding.name === 'RELEASE_FENCE_VERSION' && binding.type === 'plain_text',
  )?.text
}

function workerMaintenanceMode(version) {
  return (
    version.resources?.bindings?.find(
      (binding) =>
        binding.name === 'MAINTENANCE_MODE' && binding.type === 'plain_text',
    )?.text === '1'
  )
}

function loadPreviousConfig(io, previousReleaseSha) {
  if (!/^[0-9a-f]{40}$/i.test(previousReleaseSha ?? '')) {
    throw new Error(
      'The active Worker does not expose a valid RELEASE_SHA; previous routes and cron schedules cannot be reconstructed safely.',
    )
  }
  try {
    return parseJsonc(
      io.output('git', ['show', `${previousReleaseSha}:wrangler.jsonc`]),
    )
  } catch (error) {
    throw new Error(
      `Could not reconstruct previous routes and cron schedules from ${previousReleaseSha}.`,
      { cause: error },
    )
  }
}

function dryRunApplication(io, configPath) {
  io.run('npx', [
    'wrangler',
    'deploy',
    '--config',
    configPath,
    '--dry-run',
    '--strict',
  ])
}

function dryRunTriggers(io, configPath) {
  io.run('npx', [
    'wrangler',
    'triggers',
    'deploy',
    '--config',
    configPath,
    '--dry-run',
  ])
}

function uploadInactiveVersion(io, configPath, tag, message, sha, releasedAt) {
  io.run('npx', [
    'wrangler',
    'versions',
    'upload',
    '--config',
    configPath,
    '--strict',
    '--tag',
    tag,
    '--message',
    message,
    '--var',
    'ENVIRONMENT:production',
    '--var',
    `RELEASE_SHA:${sha}`,
    '--var',
    `RELEASE_TIME:${releasedAt}`,
  ])
}

function deployDirectApplication(io, configPath, message, sha, releasedAt) {
  io.run('npx', [
    'wrangler',
    'deploy',
    '--config',
    configPath,
    '--message',
    message,
    '--var',
    'ENVIRONMENT:production',
    '--var',
    `RELEASE_SHA:${sha}`,
    '--var',
    `RELEASE_TIME:${releasedAt}`,
  ])
}

function promoteVersion(io, configPath, tag, message) {
  io.run('npx', [
    'wrangler',
    'versions',
    'deploy',
    '--config',
    configPath,
    '--version-tag',
    `${tag}@100`,
    '--yes',
    '--message',
    message,
  ])
}

function restorePreviousVersion(io, previousVersion, message) {
  io.run('npx', [
    'wrangler',
    'versions',
    'deploy',
    `${previousVersion}@100`,
    '--yes',
    '--message',
    `${message} release verification failed; restored previous application`,
  ])
}

function pauseTaxonomyDelivery(io) {
  requireQueueDeliveryState(io, io.queueStateEnv, 'running')
  io.run('npx', [
    'wrangler',
    'queues',
    'pause-delivery',
    productionTaxonomyResources.queue,
  ])
  return verifyQueueTransitionWhenAuthoritative(io, 'paused')
}

function queryQueueDeliveryState(io, env) {
  const output = JSON.parse(
    io.output(
      'node',
      ['scripts/queue-delivery-state.mjs', productionTaxonomyResources.queue],
      env,
    ),
  )
  if (
    !['running', 'paused'].includes(output?.state) ||
    !(
      typeof output.modifiedOn === 'string' ||
      (output.modifiedOn === null && output.source === 'operator')
    )
  ) {
    throw new Error('Queue delivery state helper returned an ambiguous result.')
  }
  return output
}

function requireQueueDeliveryState(io, env, expected) {
  const actual = queryQueueDeliveryState(io, env)
  if (actual.state !== expected) {
    throw new Error(
      `Queue delivery is ${actual.state}, expected ${expected}; refusing an ownership-sensitive state transition.`,
    )
  }
  return actual
}

function sameQueueDeliverySnapshot(left, right) {
  if (left.source === 'operator' || right.source === 'operator') {
    return left.state === right.state && left.source === right.source
  }
  return left.state === right.state && left.modifiedOn === right.modifiedOn
}

function resumeTaxonomyDelivery(io, ownedQueuePauseSnapshot) {
  if (!ownedQueuePauseSnapshot) {
    throw new Error(
      'Cannot resume taxonomy delivery without the release-owned pause snapshot.',
    )
  }
  const current = queryQueueDeliveryState(io, io.queueStateEnv)
  if (!sameQueueDeliverySnapshot(ownedQueuePauseSnapshot, current)) {
    throw new Error(
      'Queue delivery state changed after the release pause; refusing to overwrite newer operator state.',
    )
  }
  io.run('npx', [
    'wrangler',
    'queues',
    'resume-delivery',
    productionTaxonomyResources.queue,
  ])
  verifyQueueTransitionWhenAuthoritative(io, 'running')
}

function verifyQueueTransitionWhenAuthoritative(io, expected) {
  const actual = queryQueueDeliveryState(io, io.queueStateEnv)
  if (actual.source !== 'operator' && actual.state !== expected) {
    throw new Error(
      `Queue delivery is ${actual.state}, expected ${expected} after the state transition.`,
    )
  }
  return actual
}

function setMaintenanceBarrier(io, configPath) {
  executeD1Json(
    io,
    configPath,
    `INSERT INTO app_state (key, value) VALUES ('${maintenanceBarrierKey}', '1')
     ON CONFLICT(key) DO UPDATE SET value = '1';
     SELECT value FROM app_state WHERE key = '${maintenanceBarrierKey}'`,
    (statement) => statement.results?.[0]?.value === '1',
    'set and verify the release maintenance barrier',
  )
}

function acquireReleaseLease(io, configPath, owner, now) {
  const acquiredAt = Math.floor(now().getTime() / 1000)
  const expiresAt = acquiredAt + releaseLeaseSeconds
  executeD1Json(
    io,
    configPath,
    `INSERT INTO app_state (key, value)
     VALUES ('${releaseLeaseKey}', json_object(
       'owner', '${sqlLiteral(owner)}',
       'acquiredAt', ${acquiredAt},
       'expiresAt', ${expiresAt}
     ))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE coalesce(json_extract(app_state.value, '$.expiresAt'), 0) <= unixepoch();
     SELECT value FROM app_state WHERE key = '${releaseLeaseKey}'`,
    (statement) => releaseLeaseOwner(statement.results?.[0]?.value) === owner,
    'acquire the release lease',
  )
  return { owner, configPath, acquiredAt, expiresAt }
}

function assertReleaseLease(io, lease, now) {
  const expiresAt = Math.floor(now().getTime() / 1000) + releaseLeaseSeconds
  executeD1Json(
    io,
    lease.configPath,
    `UPDATE app_state
     SET value = json_set(value, '$.expiresAt', ${expiresAt})
     WHERE key = '${releaseLeaseKey}'
       AND json_extract(value, '$.owner') = '${sqlLiteral(lease.owner)}'
       AND json_extract(value, '$.expiresAt') > unixepoch();
     SELECT value FROM app_state WHERE key = '${releaseLeaseKey}'`,
    (statement) =>
      releaseLeaseOwner(statement.results?.[0]?.value) === lease.owner,
    'renew and verify release lease ownership',
  )
  lease.expiresAt = expiresAt
}

function releaseReleaseLease(io, lease, now) {
  try {
    assertReleaseLease(io, lease, now)
    executeD1Json(
      io,
      lease.configPath,
      `DELETE FROM app_state
       WHERE key = '${releaseLeaseKey}'
         AND json_extract(value, '$.owner') = '${sqlLiteral(lease.owner)}';
       SELECT count(*) AS count FROM app_state
       WHERE key = '${releaseLeaseKey}'
         AND json_extract(value, '$.owner') = '${sqlLiteral(lease.owner)}'`,
      (statement) => Number(statement.results?.[0]?.count) === 0,
      'release the owned release lease',
    )
  } catch (error) {
    io.error(
      `Could not release the D1 release lease safely: ${errorMessage(error)}`,
    )
  }
}

function releaseOwnedIo(io, lease, now) {
  const queueStateEnv = io.queueStateEnv
  return {
    ...io,
    queueStateEnv,
    run(command, args, env) {
      assertReleaseLease(io, lease, now)
      try {
        return io.run(command, args, env ?? queueStateEnv)
      } finally {
        assertReleaseLease(io, lease, now)
      }
    },
    output(command, args, env) {
      if (!isLeaseCommand(args)) assertReleaseLease(io, lease, now)
      try {
        return io.output(command, args, env ?? queueStateEnv)
      } finally {
        if (!isLeaseCommand(args)) assertReleaseLease(io, lease, now)
      }
    },
  }
}

function isLeaseCommand(args) {
  return args?.some(
    (value) =>
      typeof value === 'string' &&
      (value.includes(releaseLeaseKey) ||
        value.includes("'$.owner'") ||
        value.includes("'$.expiresAt'")),
  )
}

function releaseLeaseOwner(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return typeof parsed.owner === 'string' ? parsed.owner : null
  } catch {
    return null
  }
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''")
}

function clearMaintenanceBarrier(io, configPath) {
  executeD1Json(
    io,
    configPath,
    `DELETE FROM app_state WHERE key = '${maintenanceBarrierKey}';
     SELECT count(*) AS count FROM app_state WHERE key = '${maintenanceBarrierKey}'`,
    (statement) => Number(statement.results?.[0]?.count) === 0,
    'clear and verify the release maintenance barrier',
  )
}

function executeD1Json(io, configPath, command, verify, label) {
  const parsed = JSON.parse(
    io.output('npx', [
      'wrangler',
      'd1',
      'execute',
      database,
      '--config',
      configPath,
      '--remote',
      '--json',
      '--command',
      command,
    ]),
  )
  const statements = Array.isArray(parsed) ? parsed : [parsed]
  if (
    statements.length === 0 ||
    statements.some((statement) => !statement?.success) ||
    !verify(statements.at(-1))
  ) {
    throw new Error(`Could not ${label}.`)
  }
}

function clearCronSchedules(io, maintenanceConfigPath) {
  io.run('npx', [
    'wrangler',
    'triggers',
    'deploy',
    '--config',
    maintenanceConfigPath,
  ])
}

function deployProductionTriggers(io, root) {
  deployTriggerConfig(io, resolve(root, 'wrangler.jsonc'))
}

function deployTriggerConfig(io, configPath) {
  io.run('npx', ['wrangler', 'triggers', 'deploy', '--config', configPath])
}

function deployMaintenance(io, configPath, message) {
  io.run('npx', [
    'wrangler',
    'deploy',
    '--config',
    configPath,
    '--message',
    message,
  ])
}

function runPostdeployValidation(io, configPath) {
  io.run('node', [
    'scripts/check-taxonomy-resources.mjs',
    '--remote-handlers',
    '--config',
    configPath,
    '--queue',
    productionTaxonomyResources.queue,
    '--dlq',
    productionTaxonomyResources.dlq,
  ])
}

function exportDatabase(io, backupPath) {
  io.run('npx', [
    'wrangler',
    'd1',
    'export',
    database,
    '--remote',
    '--skip-confirmation',
    '--output',
    backupPath,
  ])
  const backup = io.read(backupPath)
  if (backup.length === 0) throw new Error(`D1 backup is empty: ${backupPath}`)
  const digest = createHash('sha256').update(backup).digest('hex')
  io.write(
    `${backupPath}.sha256`,
    `${digest}  ${backupPath.split('/').at(-1)}\n`,
  )
  return digest
}

function updateJournal(io, path, journal, phase, now, fields = {}) {
  const at = now().toISOString()
  Object.assign(journal, fields, { phase, updatedAt: at })
  journal.phaseHistory.push({ phase, at })
  const value = `${JSON.stringify(journal, null, 2)}\n`
  if (io.writeAtomic) io.writeAtomic(path, value)
  else io.write(path, value)
}

function recordFailure(
  io,
  path,
  journal,
  phase,
  error,
  containmentErrors,
  now,
) {
  try {
    updateJournal(io, path, journal, phase, now, {
      failure: errorMessage(error),
      containmentErrors: containmentErrors.map(errorMessage),
    })
  } catch (journalError) {
    containmentErrors.push(journalError)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function holdMaintenance({
  io,
  maintenanceConfigPaths,
  migrationTag,
  resolveMigrationTag,
  message,
  barrierConfigPath,
  artifactHashPaths,
  artifactDigest,
  queueAlreadyPaused,
  onBarrierSet,
}) {
  const errors = []
  let paused = queueAlreadyPaused
  let cleared = false
  if (!paused) {
    try {
      pauseTaxonomyDelivery(io)
      paused = true
    } catch (error) {
      errors.push(error)
    }
  }
  const initialConfigPath = maintenanceConfigForTag(
    maintenanceConfigPaths,
    migrationTag,
  )
  try {
    assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
    clearCronSchedules(io, initialConfigPath)
    cleared = true
  } catch (error) {
    errors.push(error)
  }
  if (!paused || !cleared) return errors

  let activeMigrationTag = migrationTag
  if (resolveMigrationTag) {
    try {
      activeMigrationTag = resolveMigrationTag()
    } catch (error) {
      errors.push(error)
      return errors
    }
  }
  const maintenanceConfigPath = maintenanceConfigForTag(
    maintenanceConfigPaths,
    activeMigrationTag,
  )
  try {
    setMaintenanceBarrier(io, barrierConfigPath)
    onBarrierSet?.()
    assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
    deployMaintenance(io, maintenanceConfigPath, message)
  } catch (error) {
    errors.push(error)
  }
  return errors
}

function holdAsyncDelivery(io, maintenanceConfigPath, options = {}) {
  const operations = []
  if (options.pause !== false) operations.push(() => pauseTaxonomyDelivery(io))
  operations.push(() => {
    assertArtifactUnchanged(
      io,
      options.artifactHashPaths,
      options.artifactDigest,
    )
    clearCronSchedules(io, maintenanceConfigPath)
  })
  return attemptAll(operations)
}

function restoreCodeOnlyApplication({
  io,
  previousVersion,
  message,
  previousRestoreConfig,
  previousTriggersConfigPath,
  maintenanceConfigPath,
  candidateQueueNames,
  initialQueueDeliveryState,
  ownedQueuePauseSnapshot,
  artifactHashPaths,
  artifactDigest,
}) {
  const errors = []
  let codeRestored = false
  let triggersRestored = false
  try {
    assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
    restorePreviousVersion(io, previousVersion, message)
    codeRestored = true
  } catch (error) {
    errors.push(error)
  }
  if (codeRestored) {
    const triggerErrors = restoreTriggerAndQueueState({
      io,
      desiredConfig: previousRestoreConfig,
      configPath: previousTriggersConfigPath,
      candidateQueueNames,
      resume: initialQueueDeliveryState === 'running',
      ownedQueuePauseSnapshot,
      artifactHashPaths,
      artifactDigest,
    })
    errors.push(...triggerErrors)
    triggersRestored = triggerErrors.length === 0
  }
  if (codeRestored && triggersRestored) return errors
  errors.push(
    ...holdAsyncDelivery(io, maintenanceConfigPath, {
      pause: initialQueueDeliveryState === 'running',
      artifactHashPaths,
      artifactDigest,
    }),
  )
  return errors
}

function restoreTriggerAndQueueState({
  io,
  desiredConfig,
  configPath,
  candidateQueueNames,
  resume,
  ownedQueuePauseSnapshot,
  artifactHashPaths,
  artifactDigest,
}) {
  const errors = []
  try {
    assertArtifactUnchanged(io, artifactHashPaths, artifactDigest)
    deployTriggerConfig(io, configPath)
    reconcileQueueConsumerRemovals({
      io,
      desiredConfig,
      candidateQueueNames,
      configPath,
    })
    validateRemoteQueueConsumers(io, desiredConfig, configPath)
  } catch (error) {
    errors.push(error)
  }
  if (!errors.length && resume) {
    try {
      resumeTaxonomyDelivery(io, ownedQueuePauseSnapshot)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function releaseQueueNames(config, previousConfig, previousVersionMetadata) {
  const names = new Set()
  for (const candidate of [config, previousConfig]) {
    for (const consumer of candidate.queues?.consumers ?? []) {
      names.add(consumer.queue)
    }
  }
  for (const binding of previousVersionMetadata.resources?.bindings ?? []) {
    if (binding.type === 'queue' && binding.queue_name)
      names.add(binding.queue_name)
  }
  return [...names].sort()
}

function snapshotQueueConsumers(io, queueNames, workerName, configPath) {
  return queueNames.flatMap((queue) =>
    listWorkerConsumers(io, queue, configPath)
      .filter((consumer) => workerConsumerMatches(consumer, workerName))
      .map((consumer) => ({ queue, ...consumer })),
  )
}

function reconcileQueueConsumerRemovals({
  io,
  desiredConfig,
  candidateQueueNames,
  configPath,
}) {
  const workerName = desiredConfig.name
  const desiredQueues = new Set(
    (desiredConfig.queues?.consumers ?? []).map((consumer) => consumer.queue),
  )
  for (const queue of candidateQueueNames) {
    if (desiredQueues.has(queue)) continue
    const existing = listWorkerConsumers(io, queue, configPath).some(
      (consumer) => workerConsumerMatches(consumer, workerName),
    )
    if (!existing) continue
    io.run('npx', [
      'wrangler',
      'queues',
      'consumer',
      'worker',
      'remove',
      queue,
      workerName,
      '--config',
      configPath,
    ])
    const remains = listWorkerConsumers(io, queue, configPath).some(
      (consumer) => workerConsumerMatches(consumer, workerName),
    )
    if (remains) {
      throw new Error(
        `Queue ${queue} still exposes removed consumer ${workerName}.`,
      )
    }
  }
}

function validateRemoteQueueConsumers(io, config, configPath) {
  const failures = []
  for (const configured of config.queues?.consumers ?? []) {
    const deployed = listWorkerConsumers(io, configured.queue, configPath).find(
      (consumer) => workerConsumerMatches(consumer, config.name),
    )
    if (!deployed) {
      failures.push(
        `Queue ${configured.queue} is missing consumer ${config.name}.`,
      )
      continue
    }
    if (deployed.dead_letter_queue !== configured.dead_letter_queue) {
      failures.push(
        `Queue ${configured.queue} uses DLQ ${String(deployed.dead_letter_queue)}, expected ${String(configured.dead_letter_queue)}.`,
      )
    }
    for (const failure of validateQueueConsumerSettings(configured, deployed)) {
      failures.push(`Queue ${configured.queue} consumer ${failure}.`)
    }
  }
  if (failures.length) throw new Error(failures.join(' '))
}

function listWorkerConsumers(io, queue, configPath) {
  return JSON.parse(
    io.output('npx', [
      'wrangler',
      'queues',
      'consumer',
      'worker',
      'list',
      queue,
      '--json',
      '--config',
      configPath,
    ]),
  )
}

function workerConsumerMatches(consumer, workerName) {
  return [consumer.script, consumer.service, consumer.script_name].includes(
    workerName,
  )
}

function snapshotConsumersToConfig(consumers) {
  return consumers.map((consumer) => ({
    queue: consumer.queue,
    ...(consumer.dead_letter_queue
      ? { dead_letter_queue: consumer.dead_letter_queue }
      : {}),
    ...remoteSetting(consumer, 'batch_size', 'max_batch_size'),
    ...remoteSetting(
      consumer,
      'max_wait_time_ms',
      'max_batch_timeout',
      1 / 1000,
    ),
    ...remoteSetting(consumer, 'max_retries', 'max_retries'),
    ...remoteSetting(consumer, 'max_concurrency', 'max_concurrency'),
    ...remoteSetting(consumer, 'retry_delay', 'retry_delay'),
  }))
}

function remoteSetting(consumer, remoteKey, configKey, multiplier = 1) {
  const value = consumer.settings?.[remoteKey]
  if (value === undefined || value === null) return {}
  return { [configKey]: Number(value) * multiplier }
}

function maintenanceConfigForTag(configPaths, tag) {
  const path = configPaths.get(tag ?? '')
  if (!path) {
    throw new Error(
      `No verified immutable maintenance config exists for lifecycle tag ${String(tag)}.`,
    )
  }
  return path
}

function safeConfigName(value) {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, '-')
}

function validateInitialQueueDeliveryState(value) {
  if (!['running', 'paused'].includes(value)) {
    throw new Error(
      'Set RELEASE_TAXONOMY_QUEUE_INITIAL_STATE to running or paused after verifying the production queue state.',
    )
  }
  return value
}

function appliedDurableObjectMigrations(migrations, activeTag) {
  if (!activeTag) return []
  const activeIndex = migrations.findIndex(
    (migration) => migration.tag === activeTag,
  )
  if (activeIndex === -1) {
    throw new Error(
      `Cannot preserve unknown Durable Object migration tag ${activeTag} in the maintenance Worker.`,
    )
  }
  return migrations.slice(0, activeIndex + 1)
}

function rebaseBuildPath(path, paths) {
  if (!path) return path
  let absolute = isAbsolute(path)
    ? path
    : resolve(dirname(paths.sourceConfigPath), path)
  for (const mapping of paths.mappings ?? []) {
    if (isWithin(mapping.from, absolute)) {
      absolute = resolve(mapping.to, relative(mapping.from, absolute))
      break
    }
  }
  return rebaseAbsolutePath(absolute, paths.targetConfigPath)
}

function rebaseAbsolutePath(path, targetConfigPath) {
  const rebased = relative(dirname(targetConfigPath), path).replaceAll(
    '\\',
    '/',
  )
  return rebased || '.'
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate)
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  )
}

function writeConfig(io, path, config) {
  io.write(path, `${JSON.stringify(config, null, 2)}\n`)
}

function assertArtifactUnchanged(io, paths, expectedDigest) {
  const currentDigest = io.hash(paths)
  if (currentDigest !== expectedDigest) {
    throw new Error(
      'The verified release artifact changed after its dry run; refusing to deploy it.',
    )
  }
}

function recoveryStrategy(databasePending, lifecyclePending) {
  if (databasePending && lifecyclePending)
    return 'd1-export-and-lifecycle-fix-forward'
  if (databasePending) return 'd1-export-and-time-travel'
  if (lifecyclePending) return 'd1-time-travel-and-lifecycle-fix-forward'
  return 'worker-rollback-and-d1-time-travel'
}

function attemptAll(operations) {
  const errors = []
  for (const operation of operations) {
    try {
      operation()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function throwWithContainment(error, containmentErrors) {
  if (containmentErrors.length) {
    throw new AggregateError(
      [error, ...containmentErrors],
      'Release verification failed and one or more containment operations also failed.',
    )
  }
  throw error
}

function systemIo(root) {
  return {
    run(command, args, env = process.env) {
      execFileSync(command, args, { cwd: root, env, stdio: 'inherit' })
    },
    output(command, args, env = process.env) {
      return execFileSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        env,
      }).trim()
    },
    mkdir(path) {
      mkdirSync(path, { recursive: true })
    },
    copy(source, target) {
      rmSync(target, { recursive: true, force: true })
      cpSync(source, target, { recursive: true })
    },
    realpath: realpathSync,
    read: readFileSync,
    write: writeFileSync,
    writeAtomic(path, value) {
      const temporary = `${path}.tmp-${process.pid}`
      writeFileSync(temporary, value, { mode: 0o600 })
      renameSync(temporary, path)
    },
    hash(paths) {
      return hashPaths(paths)
    },
    sleep(milliseconds) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
    },
    log: console.log,
    error: console.error,
  }
}

function hashPaths(paths) {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) hashPath(hash, path, path)
  return hash.digest('hex')
}

function hashPath(hash, root, path) {
  const stats = statSync(path)
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  hash.update(`${stats.isDirectory() ? 'd' : 'f'}:${name}\0`)
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
if (isMain) runRelease()
