import { AutomationBox, AutomationMetric } from './admin-automation-ui'
import {
  buttonClass,
  dangerButtonClass,
  fieldClass,
  primaryButtonClass,
  selectedButtonClass,
} from './oddweb'
import {
  basisPoints,
  humanize,
  modeDisabledReason,
  modeLabel,
  optionalBasisPoints,
} from '../lib/admin-format'
import { canTransitionMode } from '../lib/admin-parsers'

import type { AutomationOverviewModel } from './admin-automation-section'

export function AutomationOverview({
  model,
}: {
  model: AutomationOverviewModel
}) {
  const {
    backfillCursor,
    backfillMutation,
    changeMode,
    changeSiteClassification,
    circuitMutation,
    controlPlanePending,
    dashboard,
    modeMutation,
    modeOptions,
    resetCircuit,
    runBackfill,
    setBackfillCursor,
    siteClassificationMutation,
  } = model

  return (
    <>
      <dl className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <AutomationMetric
          label="Health"
          value={dashboard.health.healthy ? 'Healthy' : 'Degraded'}
          note={`Mode: ${modeLabel(dashboard.state.mode)}`}
        />
        <AutomationMetric
          label="Published version"
          value={String(dashboard.state.publishedVersion)}
          note={`Provider #${dashboard.state.activeProviderConfigId ?? '-'} / Policy #${dashboard.state.activePolicyConfigId ?? '-'}`}
        />
        <AutomationMetric
          label="Circuit"
          value={humanize(dashboard.state.circuitState)}
          note={dashboard.state.circuitReason || 'No active trip reason'}
        />
        <AutomationMetric
          label="Daily budget"
          value={`${dashboard.health.budget.requests.toLocaleString('en')} / ${dashboard.health.budget.requestLimit?.toLocaleString('en') ?? 'not configured'}`}
          note={`${dashboard.health.budget.tokens.toLocaleString('en')} / ${dashboard.health.budget.tokenLimit?.toLocaleString('en') ?? 'not configured'} tokens`}
        />
      </dl>

      <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_1fr]">
        <AutomationBox title="Counts and current-mode circuit signals">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries({
              'Enabled providers': dashboard.counts.enabledProviders,
              'Queued jobs': dashboard.counts.queuedJobs,
              'Dead jobs': dashboard.counts.deadJobs,
              'Active locks': dashboard.counts.activeLocks,
              'Proposed concepts': dashboard.counts.proposedCandidates,
              'Unclassified sites': dashboard.counts.unclassifiedSites,
              Attempts: dashboard.health.circuit.attempts,
              'Schema failures': dashboard.health.circuit.schemaFailures,
              Disagreements: dashboard.health.circuit.disagreements,
              Rollbacks: dashboard.health.circuit.rollbacks,
              Mutations: dashboard.health.circuit.mutations,
            }).map(([label, value]) => (
              <div key={label} className="border border-line bg-paper p-2">
                <dt className="font-mono text-[11px] text-muted uppercase">
                  {label}
                </dt>
                <dd className="m-0 font-mono text-lg font-bold">
                  {value.toLocaleString('en')}
                </dd>
              </div>
            ))}
          </dl>
        </AutomationBox>

        <AutomationBox
          title="Readiness gate"
          label={dashboard.readiness.readyForGradual ? 'READY' : 'BLOCKED'}
        >
          <ul className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2">
            {Object.entries(dashboard.readiness.checks).map(
              ([check, passed]) => (
                <li
                  key={check}
                  className="flex justify-between border border-line bg-paper p-2 text-sm"
                >
                  <span>{humanize(check)}</span>
                  <strong className={passed ? 'text-success' : 'text-danger'}>
                    {passed ? 'Pass' : 'Fail'}
                  </strong>
                </li>
              ),
            )}
          </ul>
          <p className="mt-2 mb-0 font-mono text-xs text-muted">
            Samples {dashboard.readiness.metrics.samples}/
            {dashboard.readiness.thresholds.samples ?? 'not configured'};
            coverage{' '}
            {basisPoints(dashboard.readiness.metrics.coverageBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.coverageBasisPoints,
            )}
            ; schema{' '}
            {basisPoints(dashboard.readiness.metrics.schemaSuccessBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.schemaSuccessBasisPoints,
            )}
            ; agreement{' '}
            {basisPoints(dashboard.readiness.metrics.agreementBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.agreementBasisPoints,
            )}
            .
          </p>
        </AutomationBox>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <AutomationBox title="Mode and circuit controls">
          <fieldset
            className="m-0 border-0 p-0"
            aria-describedby="automation-mode-help"
          >
            <legend className="sr-only">Automation mode</legend>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Automation mode controls"
            >
              {modeOptions.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${dashboard.state.mode === mode ? selectedButtonClass : buttonClass} min-h-9`}
                  aria-pressed={dashboard.state.mode === mode}
                  disabled={
                    controlPlanePending ||
                    dashboard.state.mode === mode ||
                    (mode !== 'disabled' &&
                      (dashboard.state.activeProviderConfigId === null ||
                        dashboard.state.activePolicyConfigId === null)) ||
                    !canTransitionMode(
                      dashboard.state.mode,
                      mode,
                      dashboard.readiness.readyForGradual,
                      dashboard.state.circuitState,
                    )
                  }
                  aria-describedby={`automation-mode-help automation-mode-${mode}-reason`}
                  title={modeDisabledReason(
                    dashboard.state,
                    mode,
                    dashboard.readiness.readyForGradual,
                  )}
                  onClick={() => changeMode(mode)}
                >
                  {modeMutation.isPending && modeMutation.variables === mode
                    ? 'Changing...'
                    : modeLabel(mode)}
                </button>
              ))}
              <button
                type="button"
                className={`${dashboard.state.siteClassificationEnabled ? buttonClass : selectedButtonClass} min-h-9`}
                aria-pressed={!dashboard.state.siteClassificationEnabled}
                disabled={controlPlanePending}
                onClick={() =>
                  changeSiteClassification(
                    !dashboard.state.siteClassificationEnabled,
                  )
                }
              >
                {siteClassificationMutation.isPending
                  ? 'Changing...'
                  : dashboard.state.siteClassificationEnabled
                    ? 'Disable site classification'
                    : 'Enable site classification'}
              </button>
              <button
                type="button"
                className={`${dangerButtonClass} min-h-9`}
                disabled={controlPlanePending}
                onClick={resetCircuit}
              >
                {circuitMutation.isPending ? 'Resetting...' : 'Reset circuit'}
              </button>
            </div>
            {modeOptions.map((mode) => (
              <span
                key={mode}
                id={`automation-mode-${mode}-reason`}
                className="sr-only"
              >
                {modeDisabledReason(
                  dashboard.state,
                  mode,
                  dashboard.readiness.readyForGradual,
                )}
              </span>
            ))}
          </fieldset>
          <p id="automation-mode-help" className="mt-2 mb-0 text-xs text-muted">
            Promotion is sequential: disabled to shadow, shadow to gradual after
            the readiness gate, then gradual to autonomous. Degraded mode
            requires a circuit reset. Site classification can be disabled
            independently without stopping concept reassessment.
          </p>
        </AutomationBox>

        <AutomationBox title="Bounded classification backfill">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={runBackfill}
          >
            <label className="min-w-32 flex-1">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Batch limit
              </span>
              <input
                className={fieldClass}
                type="number"
                name="limit"
                min="1"
                max="100"
                defaultValue="25"
                required
              />
            </label>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={backfillMutation.isPending || backfillCursor === null}
            >
              {backfillMutation.isPending
                ? 'Queueing...'
                : backfillCursor === 0
                  ? 'Start backfill'
                  : backfillCursor === null
                    ? 'Backfill complete'
                    : 'Continue backfill'}
            </button>
            {backfillCursor === null ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => setBackfillCursor(0)}
              >
                Start over
              </button>
            ) : null}
          </form>
          <p className="mt-2 mb-0 font-mono text-xs text-muted">
            Next cursor: {backfillCursor ?? 'complete'}
          </p>
        </AutomationBox>
      </div>
    </>
  )
}
