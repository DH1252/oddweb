import type {
  activateTaxonomyProvider,
  disableTaxonomyProvider,
  enableTaxonomyProvider,
  testTaxonomyProvider,
} from '../server/taxonomy-admin'

export type TaxonomyMode =
  'disabled' | 'shadow' | 'gradual' | 'autonomous' | 'degraded'
export type TaxonomyJobStatus =
  | 'pending'
  | 'leased'
  | 'retry_wait'
  | 'succeeded'
  | 'settled'
  | 'obsolete'
  | 'dead'
  | 'cancelled'
  | 'degraded'
export type TaxonomyJobKind =
  'classify_site' | 'reassess_concept' | 'apply_ontology' | 'rollback'
export type TaxonomyBatchStatus =
  | 'planned'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'partial'
export type TaxonomyLockScope =
  'site_assignment' | 'tag' | 'alias' | 'merge' | 'parent_edge'
export type TaxonomyLockInput =
  | {
      scope: 'site_assignment'
      siteId: number
      tagId: number
      reason: string
    }
  | { scope: 'tag'; tagId: number; reason: string }
  | { scope: 'alias'; tagId: number; alias: string; reason: string }
  | {
      scope: 'merge' | 'parent_edge'
      tagId: number
      relatedTagId: number
      reason: string
    }
export type RollbackInput =
  | { kind: 'event'; id: string }
  | { kind: 'site'; id: string }
  | { kind: 'batch'; id: string }
export type ProviderActionInput = {
  action: 'test' | 'enable' | 'activate' | 'disable'
  providerConfigId: number
}
export type ProviderActionResult =
  | Awaited<ReturnType<typeof testTaxonomyProvider>>
  | Awaited<ReturnType<typeof enableTaxonomyProvider>>
  | Awaited<ReturnType<typeof activateTaxonomyProvider>>
  | Awaited<ReturnType<typeof disableTaxonomyProvider>>
