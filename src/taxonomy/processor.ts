import { env } from 'cloudflare:workers'

import {
  dispatchTaxonomyOutbox as dispatch,
  processTaxonomyMessage as process,
  runTaxonomyMaintenance as maintain,
} from './runtime'

export function processTaxonomyMessage(jobId: string) {
  return process({ jobId }, env)
}

export function dispatchTaxonomyOutbox(
  options: Parameters<typeof dispatch>[1] = {},
) {
  return dispatch(env, options)
}

export function runTaxonomyMaintenance() {
  return maintain(env)
}
