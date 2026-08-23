import { AutomationBox, AutomationInput } from './admin-automation-ui'
import { AdminPagination, Empty } from './admin-ui'
import { LocalTime } from './local-time'
import {
  buttonClass,
  dangerButtonClass,
  fieldClass,
  primaryButtonClass,
} from './oddweb'
import { automationPageSize } from './admin-automation-shared'
import { basisPoints, formatTimestamp, humanize } from '../lib/admin-format'
import { policyFields } from '../lib/taxonomy-policy-form'

import type { AutomationProviderPolicyModel } from './admin-automation-section'

type Provider = AutomationProviderPolicyModel['providers']['items'][number]

export function AutomationProvidersPolicies({
  model,
}: {
  model: AutomationProviderPolicyModel
}) {
  return (
    <>
      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[1.1fr_.9fr]">
        <ProviderConfigurations model={model} />
        <ProviderCreate model={model} />
      </div>
      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[.8fr_1.2fr]">
        <PolicyRevisions model={model} />
        <PolicyEditor model={model} />
      </div>
    </>
  )
}

function ProviderConfigurations({
  model,
}: {
  model: AutomationProviderPolicyModel
}) {
  const { providers, setProviderPage } = model
  return (
    <AutomationBox
      title="Provider configurations"
      label={`${providers.total} REVISIONS`}
    >
      {providers.items.length ? (
        <>
          <ul
            id="taxonomy-provider-results"
            tabIndex={-1}
            className="m-0 grid list-none gap-2 p-0 outline-none sm:grid-cols-2"
          >
            {providers.items.map((provider) => (
              <ProviderCard
                key={String(provider.id)}
                model={model}
                provider={provider}
              />
            ))}
          </ul>
          <AdminPagination
            page={providers.page}
            total={providers.total}
            pageSize={automationPageSize}
            onChange={setProviderPage}
            label="Provider configuration pages"
            focusTargetId="taxonomy-provider-results"
          />
        </>
      ) : (
        <Empty
          title="No providers."
          text="Create a provider configuration to begin shadow evaluation."
        />
      )}
    </AutomationBox>
  )
}

function ProviderCard({
  model,
  provider,
}: {
  model: AutomationProviderPolicyModel
  provider: Provider
}) {
  const {
    controlPlanePending,
    deleteProvider,
    editingProviderId,
    providerActionMutation,
    providerUpdateMutation,
    runProviderAction,
    setEditingProviderId,
    submitProviderUpdate,
  } = model
  const id = Number(provider.id)
  return (
    <li className="flex min-w-0 flex-col justify-between border border-line bg-paper p-2">
      <div>
        <strong className="block">{String(provider.name)}</strong>
        <span className="font-mono text-xs text-muted">
          #{String(provider.id)} r{String(provider.revision)} /{' '}
          {humanize(String(provider.providerKind))}
          <br />
          {String(provider.model)}
        </span>
      </div>
      <p className="my-2 font-mono text-xs [overflow-wrap:anywhere]">
        {String(provider.routingGroup)} /{' '}
        {humanize(String(provider.routingRole))}{' '}
        {String(provider.routingPriority)}
        <br />
        {String(provider.endpoint)}
        <br />
        {String(provider.timeoutMs)} ms
      </p>
      <p className="my-1 font-mono text-xs">
        {String(provider.credentialFingerprint)}
      </p>
      <strong className="mb-2 block font-mono text-xs uppercase">
        {provider.active ? 'Active' : provider.enabled ? 'Enabled' : 'Disabled'}
      </strong>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={buttonClass}
          disabled={controlPlanePending}
          onClick={() => runProviderAction('test', id)}
        >
          {providerActionMutation.isPending &&
          providerActionMutation.variables.providerConfigId === id &&
          providerActionMutation.variables.action === 'test'
            ? 'Testing...'
            : 'Test'}
        </button>
        {!provider.active && provider.enabled ? (
          <button
            type="button"
            className={buttonClass}
            disabled={controlPlanePending}
            onClick={() => runProviderAction('activate', id)}
          >
            Activate
          </button>
        ) : null}
        {!provider.enabled ? (
          <button
            type="button"
            className={buttonClass}
            disabled={controlPlanePending}
            onClick={() => runProviderAction('enable', id)}
          >
            {providerActionMutation.isPending &&
            providerActionMutation.variables.providerConfigId === id &&
            providerActionMutation.variables.action === 'enable'
              ? 'Testing...'
              : 'Test and enable'}
          </button>
        ) : null}
        {provider.enabled ? (
          <button
            type="button"
            className={buttonClass}
            disabled={controlPlanePending}
            onClick={() => runProviderAction('disable', id)}
          >
            Disable
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass}
          disabled={controlPlanePending}
          onClick={() =>
            setEditingProviderId((current) => (current === id ? null : id))
          }
        >
          {editingProviderId === id ? 'Close editor' : 'Edit'}
        </button>
        {!provider.enabled && !provider.active ? (
          <button
            type="button"
            className={dangerButtonClass}
            disabled={controlPlanePending}
            onClick={() => deleteProvider(id)}
          >
            Delete
          </button>
        ) : null}
      </div>
      {editingProviderId === id ? (
        <form
          key={`edit-${id}`}
          onSubmit={(event) =>
            submitProviderUpdate(
              event,
              provider.providerKind === 'gemini'
                ? 'gemini'
                : 'openai_compatible',
              id,
            )
          }
          className="mt-2 grid gap-2 border-t border-line pt-2"
        >
          <fieldset
            disabled={controlPlanePending}
            className="m-0 grid min-w-0 gap-2 border-0 p-0"
          >
            <ProviderEditInput name="name" label="Name" value={provider.name} />
            <ProviderEditInput
              name="endpoint"
              label="Endpoint"
              value={provider.endpoint}
              type="url"
            />
            <ProviderEditInput
              name="model"
              label="Model"
              value={provider.model}
            />
            {provider.providerKind !== 'gemini' ? (
              <label className="grid gap-1 font-mono text-xs">
                Dialect
                <select
                  name="dialect"
                  defaultValue={String(provider.dialect ?? 'responses')}
                  className="border border-line bg-paper px-2 py-1"
                >
                  <option value="responses">responses</option>
                  <option value="chat_completions">chat_completions</option>
                </select>
              </label>
            ) : null}
            <ProviderEditInput
              name="routingGroup"
              label="Routing group"
              value={provider.routingGroup}
            />
            <label className="grid gap-1 font-mono text-xs">
              Routing role
              <select
                name="routingRole"
                defaultValue={String(provider.routingRole)}
                className="border border-line bg-paper px-2 py-1"
              >
                <option value="primary">primary</option>
                <option value="failover">failover</option>
                <option value="consensus">consensus</option>
              </select>
            </label>
            <ProviderEditInput
              name="routingPriority"
              label="Routing priority"
              value={provider.routingPriority}
              type="number"
              min={0}
            />
            <ProviderEditInput
              name="timeoutMs"
              label="Timeout (ms)"
              value={provider.timeoutMs}
              type="number"
              min={1000}
              max={120000}
            />
            <label className="grid gap-1 font-mono text-xs">
              New API key (optional)
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="Leave empty to keep the stored key"
                className="border border-line bg-paper px-2 py-1"
              />
            </label>
            <p className="m-0 font-mono text-xs text-muted">
              Changing the endpoint, model, dialect, or key disables the
              provider until it passes a new test.
            </p>
            <button type="submit" className={buttonClass}>
              {providerUpdateMutation.isPending ? 'Saving...' : 'Save provider'}
            </button>
          </fieldset>
        </form>
      ) : null}
    </li>
  )
}

function ProviderEditInput({
  name,
  label,
  value,
  type = 'text',
  min,
  max,
}: {
  name: string
  label: string
  value: unknown
  type?: string
  min?: number
  max?: number
}) {
  return (
    <label className="grid gap-1 font-mono text-xs">
      {label}
      <input
        name={name}
        type={type}
        min={min}
        max={max}
        defaultValue={String(value)}
        className="border border-line bg-paper px-2 py-1"
      />
    </label>
  )
}

function ProviderCreate({ model }: { model: AutomationProviderPolicyModel }) {
  const {
    controlPlanePending,
    providerCreateMutation,
    providerKind,
    setProviderKind,
    submitProvider,
  } = model
  return (
    <AutomationBox title="Create provider">
      <form onSubmit={submitProvider} autoComplete="off">
        <fieldset
          disabled={controlPlanePending}
          className="m-0 min-w-0 border-0 p-0"
        >
          <div className="grid gap-x-2 sm:grid-cols-2">
            <AutomationInput
              label="Configuration name"
              name="name"
              placeholder="Production classifier"
              maxLength={100}
            />
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Provider type
              </span>
              <select
                name="providerKind"
                className={fieldClass}
                value={providerKind}
                onChange={(event) =>
                  setProviderKind(event.target.value as typeof providerKind)
                }
              >
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <AutomationInput
              label="Endpoint"
              name="endpoint"
              type="url"
              placeholder={
                providerKind === 'gemini'
                  ? 'https://generativelanguage.googleapis.com/...'
                  : 'https://api.openai.com/v1/...'
              }
            />
            <AutomationInput
              label="Model"
              name="model"
              placeholder="Model identifier"
              maxLength={200}
            />
            {providerKind === 'openai_compatible' ? (
              <label className="mb-2.5 block">
                <span className="mb-1 block font-mono text-xs font-bold uppercase">
                  Dialect
                </span>
                <select name="dialect" className={fieldClass}>
                  <option value="responses">Responses API</option>
                  <option value="chat_completions">Chat completions</option>
                </select>
              </label>
            ) : null}
            <AutomationInput
              label="Routing group"
              name="routingGroup"
              placeholder="default"
              defaultValue="default"
              maxLength={100}
            />
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Routing role
              </span>
              <select name="routingRole" className={fieldClass}>
                <option value="primary">Primary</option>
                <option value="failover">Failover</option>
                <option value="consensus">Consensus</option>
              </select>
            </label>
            <AutomationInput
              label="Routing priority"
              name="routingPriority"
              type="number"
              placeholder="0"
              defaultValue="0"
              min="0"
              max="10000"
            />
            <AutomationInput
              label="Timeout (ms)"
              name="timeoutMs"
              type="number"
              placeholder="30000"
              defaultValue="30000"
              min="1000"
              max="120000"
            />
            <AutomationInput
              label="API key"
              name="apiKey"
              type="password"
              placeholder="Cleared immediately after submit"
              autoComplete="new-password"
              maxLength={5000}
            />
          </div>
          <label className="mb-2.5 flex items-center gap-2 border border-dotted border-line bg-paper p-2">
            <input type="checkbox" name="enabled" defaultChecked />{' '}
            <span>Enable this revision after creation</span>
          </label>
          <button type="submit" className={primaryButtonClass}>
            {providerCreateMutation.isPending
              ? 'Creating...'
              : 'Create provider'}
          </button>
        </fieldset>
        <p className="mt-2 mb-0 text-xs text-muted">
          Credentials are encrypted server-side. The key field is cleared before
          the request completes and is never returned.
        </p>
      </form>
    </AutomationBox>
  )
}

function PolicyRevisions({ model }: { model: AutomationProviderPolicyModel }) {
  const {
    activatePolicy,
    controlPlanePending,
    editPolicy,
    policies,
    policyActivateMutation,
    setPolicyPage,
  } = model
  return (
    <AutomationBox
      title="Policy revisions"
      label={`${policies.total} REVISIONS`}
    >
      {policies.items.length ? (
        <>
          <ul
            id="taxonomy-policy-results"
            tabIndex={-1}
            className="m-0 grid list-none gap-2 p-0 outline-none"
          >
            {policies.items.map((policy) => (
              <li
                key={String(policy.id)}
                className="border border-line bg-paper p-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <strong className="font-mono">
                      Revision {String(policy.revision)}
                    </strong>
                    <span className="ml-2 text-xs text-muted">
                      #{String(policy.id)} /{' '}
                      <LocalTime
                        seconds={Number(policy.createdAt)}
                        fallback={formatTimestamp(policy.createdAt)}
                        style="dateTime"
                      />{' '}
                      / {String(policy.createdBy)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {policy.active ? (
                      <strong className="border border-success px-1.5 py-0.5 font-mono text-xs text-success uppercase">
                        Active
                      </strong>
                    ) : (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={controlPlanePending}
                        onClick={() => activatePolicy(Number(policy.id))}
                      >
                        {policyActivateMutation.isPending &&
                        policyActivateMutation.variables === Number(policy.id)
                          ? 'Activating...'
                          : 'Activate'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={controlPlanePending}
                      onClick={() => editPolicy(policy)}
                    >
                      Edit
                    </button>
                  </div>
                </div>
                <p className="mt-1 mb-0 font-mono text-xs text-muted">
                  Assignments {String(policy.assignmentLimit)} / rollout{' '}
                  {basisPoints(Number(policy.rolloutBasisPoints))} / requests{' '}
                  {Number(policy.dailyRequestBudget).toLocaleString('en')} /
                  tokens {Number(policy.dailyTokenBudget).toLocaleString('en')}
                </p>
              </li>
            ))}
          </ul>
          <AdminPagination
            page={policies.page}
            total={policies.total}
            pageSize={automationPageSize}
            onChange={setPolicyPage}
            label="Policy revision pages"
            focusTargetId="taxonomy-policy-results"
          />
        </>
      ) : (
        <Empty
          title="No policy revisions."
          text="Create the initial safe-controls policy."
        />
      )}
    </AutomationBox>
  )
}

function PolicyEditor({ model }: { model: AutomationProviderPolicyModel }) {
  const {
    controlPlanePending,
    initialPolicy,
    policyCreateMutation,
    policyDraft,
    setPolicyDraft,
    submitPolicy,
  } = model
  return (
    <AutomationBox
      title={
        policyDraft
          ? `Edit policy revision ${policyDraft.sourceRevision}`
          : 'Create safe-controls revision'
      }
    >
      <form
        key={String(
          policyDraft?.sourceId ??
            ('id' in initialPolicy ? initialPolicy.id : 'default'),
        )}
        onSubmit={submitPolicy}
      >
        <div className="grid gap-x-2 sm:grid-cols-2 lg:grid-cols-3">
          {policyFields.map((field) => (
            <AutomationInput
              key={field.name}
              label={field.label}
              name={field.name}
              type={field.type || 'number'}
              placeholder={field.placeholder || ''}
              defaultValue={String(initialPolicy[field.name])}
              min={field.min}
              max={field.max}
              maxLength={field.maxLength}
              pattern={field.pattern}
              step="1"
            />
          ))}
        </div>
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={controlPlanePending}
        >
          {policyCreateMutation.isPending
            ? 'Creating...'
            : policyDraft
              ? 'Save as new revision'
              : 'Create policy revision'}
        </button>
        {policyDraft ? (
          <button
            type="button"
            className={`ml-1 ${buttonClass}`}
            disabled={controlPlanePending}
            onClick={() => setPolicyDraft(null)}
          >
            Discard edits
          </button>
        ) : null}
        <p className="mt-2 mb-0 text-xs text-muted">
          Editing creates a new audited revision and preserves the selected
          revision unchanged. Creation does not activate the revision.
        </p>
      </form>
    </AutomationBox>
  )
}
