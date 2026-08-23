import {
  AutomationAuditEvents,
  AutomationLocks,
} from './admin-automation-audit-locks'
import { AutomationCandidates } from './admin-automation-candidates'
import { useAutomationController } from './admin-automation-controller'
import {
  AutomationChangeBatches,
  AutomationJobsBatches,
} from './admin-automation-jobs-batches'
import { AutomationOverview } from './admin-automation-overview'
import { AutomationProvidersPolicies } from './admin-automation-providers-policies'

export type AutomationController = ReturnType<typeof useAutomationController>
export type AutomationOverviewModel = AutomationController['overview']
export type AutomationProviderPolicyModel =
  AutomationController['providerPolicy']
export type AutomationCandidatesModel = AutomationController['candidates']
export type AutomationJobsBatchesModel = AutomationController['jobsBatches']
export type AutomationAuditLocksModel = AutomationController['auditLocks']

export function AutomationSection({
  showStatus,
  handleAdminError,
}: {
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
}) {
  const controller = useAutomationController({ showStatus, handleAdminError })
  return (
    <section
      className="mt-3 border-2 border-ink bg-canvas p-2.5"
      aria-labelledby="automation-title"
    >
      <header className="mb-2.5 border-b-2 border-ink bg-brown p-3 text-paper">
        <p className="m-0 font-mono text-[11px] tracking-[0.08em] uppercase">
          Taxonomy operations
        </p>
        <h2 id="automation-title" className="m-0 font-mono text-2xl font-bold">
          Automation
        </h2>
      </header>
      <AutomationOverview model={controller.overview} />
      <AutomationProvidersPolicies model={controller.providerPolicy} />
      <AutomationCandidates model={controller.candidates} />
      <AutomationJobsBatches model={controller.jobsBatches} />
      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <AutomationAuditEvents model={controller.auditLocks} />
        <AutomationChangeBatches model={controller.jobsBatches} />
      </div>
      <AutomationLocks model={controller.auditLocks} />
    </section>
  )
}
