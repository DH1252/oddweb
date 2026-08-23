import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { jobSnapshotIdentity } from '../src/components/admin-automation-jobs-state'

async function componentSource(file: string) {
  return readFile(new URL(`../src/components/${file}`, import.meta.url), 'utf8')
}

test('tag suggestion click commits the query instead of the click event', async () => {
  const source = await componentSource('tag-input.tsx')
  assert.match(source, /onAddQuery=\{\(\) => addTag\(\)\}/)
  assert.doesNotMatch(source, /onAddQuery=\{addTag\}/)
})

test('job snapshot identity preserves unchanged data and changes with job content', () => {
  const jobs = {
    page: 0,
    total: 2,
    items: [
      { id: 'one', status: 'dead', updatedAt: 1 },
      { id: 'two', status: 'pending', updatedAt: 2 },
    ],
  }
  const original = jobSnapshotIdentity(jobs, null, null)
  assert.equal(jobSnapshotIdentity(structuredClone(jobs), null, null), original)
  assert.notEqual(
    jobSnapshotIdentity({ ...jobs, items: jobs.items.slice(0, 1) }, null, null),
    original,
  )
  assert.notEqual(
    jobSnapshotIdentity(
      {
        ...jobs,
        items: [{ ...jobs.items[0], updatedAt: 3 }, jobs.items[1]],
      },
      null,
      null,
    ),
    original,
  )
})

test('job selection state is owned by a keyed jobs view', async () => {
  const source = await componentSource('admin-automation-jobs-batches.tsx')
  assert.match(source, /<AutomationJobs key=\{snapshotIdentity\}/)
  assert.match(source, /const \[selectedJobs, setSelectedJobs\] = useState/)
})

test('automation filters include every supported job and batch value', async () => {
  const source = await componentSource('admin-automation-jobs-batches.tsx')
  for (const value of [
    'classify_site',
    'reassess_concept',
    'apply_ontology',
    'rollback',
    'planned',
    'applying',
    'applied',
    'failed',
    'rolling_back',
    'rolled_back',
    'partial',
  ]) {
    assert.match(source, new RegExp(`'${value}'`))
  }
})

test('local time keeps machine-readable markup before hydration', async () => {
  const source = await componentSource('local-time.tsx')
  assert.match(
    source,
    /const label = hydrated \? formatLocalTime\(date, style\) : fallback/,
  )
  assert.match(
    source,
    /<time dateTime=\{date\.toISOString\(\)\}>\{label\}<\/time>/,
  )
})

test('candidate evidence uses the backend evidence identity', async () => {
  const source = await componentSource('admin-automation-candidates.tsx')
  assert.match(source, /key=\{evidence\.id\}/)
  assert.doesNotMatch(source, /key=\{`\$\{evidence\.siteId\}/)
})

test('automation sections use grouped interfaces without a context locator', async () => {
  const [section, controller] = await Promise.all([
    componentSource('admin-automation-section.tsx'),
    componentSource('admin-automation-controller.ts'),
  ])
  assert.doesNotMatch(section, /createContext|useContext|AutomationContext/)
  assert.doesNotMatch(controller, /createContext|useContext|AutomationContext/)
  for (const group of [
    'overview',
    'providerPolicy',
    'candidates',
    'jobsBatches',
    'auditLocks',
  ]) {
    assert.match(controller, new RegExp(`${group}: \\{`))
  }
})
