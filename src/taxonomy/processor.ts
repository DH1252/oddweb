import { env } from 'cloudflare:workers'

import {
  dispatchTaxonomyOutbox as dispatch,
  processTaxonomyMessage as process,
  runTaxonomyMaintenance as maintain,
} from './runtime'

export function processTaxonomyMessage(jobId: string) {
  return process({ jobId }, env)
}

export function dispatchTaxonomyOutbox() {
  return dispatch(env)
}

export function runTaxonomyMaintenance() {
  return maintain(env)
}
