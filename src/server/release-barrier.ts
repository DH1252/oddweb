import { createMiddleware } from '@tanstack/react-start'

export const releaseMaintenanceKey = 'release:maintenance'
export const releaseBarrierRetrySeconds = 60

export type ReleaseBarrierState = {
  maintenanceValue: string | null
  seedReady: boolean
}

type ReleaseWriteBarrierInput<TResult> = {
  request: Request
  handlerType: 'serverFn' | 'router'
  readBarrierState: () => Promise<ReleaseBarrierState>
  next: () => TResult
}

export async function enforceReleaseWriteBarrier<TResult>({
  handlerType,
  readBarrierState,
  next,
}: ReleaseWriteBarrierInput<TResult>): Promise<Awaited<TResult> | Response> {
  if (handlerType !== 'serverFn') return await next()

  let state: ReleaseBarrierState
  try {
    state = await readBarrierState()
  } catch (error) {
    console.error({
      event: 'release_write_barrier_check_failed',
      error: error instanceof Error ? error.message : String(error),
    })
    return releaseBarrierResponse()
  }

  if (state.maintenanceValue === null || state.maintenanceValue === '0') {
    return await next()
  }
  return releaseBarrierResponse()
}

export function createReleaseWriteBarrierMiddleware() {
  return createMiddleware().server(async ({ handlerType, next }) => {
    if (handlerType !== 'serverFn') return next()

    const [{ env }, { runWithReleaseInvocation }] = await Promise.all([
      import('cloudflare:workers'),
      import('./release-barrier.server'),
    ])

    const invocation = await runWithReleaseInvocation(
      'fetch',
      async () => await next(),
      { database: env.DB },
    )
    return invocation.admitted ? invocation.value : releaseBarrierResponse()
  })
}

export function releaseMaintenanceResponse() {
  return releaseBarrierResponse()
}

function releaseBarrierResponse() {
  return new Response(
    'Writes are temporarily unavailable during maintenance.',
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': String(releaseBarrierRetrySeconds),
      },
    },
  )
}
