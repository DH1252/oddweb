import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('admin timestamps use UTC to keep server and client markup identical', async () => {
  const source = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /function formatTimestamp[\s\S]*?timeZone: 'UTC'/)
})

test('CSP permits the Cloudflare Web Analytics beacon', async () => {
  const source = await readFile(
    new URL('../src/routes/__root.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /script-src[^"\n]*https:\/\/static\.cloudflareinsights\.com/,
  )
})

test('modal dismissal requires a complete backdrop pointer gesture', async () => {
  const source = await readFile(
    new URL('../src/components/oddweb.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /onPointerDown/)
  assert.match(source, /onPointerUp/)
  assert.match(source, /startedOnBackdrop/)
  assert.doesNotMatch(source, /onClick=\{\(event\) => \{\s*if \(closeDisabled/)
})

test('tag suggestion Escape does not dismiss its containing dialog', async () => {
  const source = await readFile(
    new URL('../src/components/tag-input.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /event\.key === 'Escape'[\s\S]*?if \(!open\) return[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/,
  )
})

test('tag input Enter prefers canonical suggestions over freeform text', async () => {
  const source = await readFile(
    new URL('../src/components/tag-input.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /async function commitEnteredTag[\s\S]*visibleSuggestion[\s\S]*addToken\(visibleSuggestion\.slug\)/,
  )
  assert.match(
    source,
    /fetchQuery\([\s\S]*tagSuggestionsQueryOptions[\s\S]*result\.suggestions\.find\([\s\S]*tag\.slug === input[\s\S]*tag\.aliases\.includes\(input\)[\s\S]*result\.suggestions\.at\(0\)[\s\S]*addToken\(suggestion\.slug\)[\s\S]*else addTag\(input\)/,
  )
  assert.match(
    source,
    /event\.key === 'Enter'[\s\S]*event\.preventDefault\(\)[\s\S]*commitEnteredTag\(\)/,
  )
})

test('tag lookup rejection retains input and exposes an accessible error', async () => {
  const source = await readFile(
    new URL('../src/components/tag-input.tsx', import.meta.url),
    'utf8',
  )
  const commit = source.match(
    /async function commitEnteredTag[\s\S]*?\n {2}function removeTag/,
  )?.[0]

  assert.ok(commit)
  assert.match(
    commit,
    /catch \{[\s\S]*setLookupError\(\{ query: input, message: tagLookupErrorMessage \}\)/,
  )
  assert.doesNotMatch(
    commit.match(/catch \{[\s\S]*?\n {4}\} finally/)?.[0] || '',
    /setQuery\(/,
  )
  assert.match(source, /maxLength=\{tagInputMaxLength\}/)
  assert.match(source, /id=\{`\$\{id\}-lookup-error`\}/)
  assert.match(source, /visibleLookupError[\s\S]*role="alert"/)
  assert.match(
    source,
    /aria-describedby=[\s\S]*visibleLookupError[\s\S]*lookup-error/,
  )
  assert.match(source, /recoveredLookup[\s\S]*suggestionQuery\.isSuccess/)
})

test('semantic button tones override shared hover colors', async () => {
  const source = await readFile(
    new URL('../src/components/oddweb.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /export const buttonBaseClass/)
  assert.match(
    source,
    /export const buttonClass = `\$\{buttonBaseClass\}[\s\S]*bg-paper[\s\S]*text-ink/,
  )
  assert.match(
    source,
    /export const selectedButtonClass = `\$\{buttonBaseClass\}[\s\S]*bg-brown[\s\S]*text-paper/,
  )
  assert.match(source, /successButtonClass[\s\S]*hover:bg-\[#24592f\]/)
  assert.match(source, /dangerButtonClass[\s\S]*hover:bg-\[#78221c\]/)
  assert.match(
    source,
    /primaryButtonClass = `\$\{buttonBaseClass\}[\s\S]*disabled:bg-\[#e5d8bb\][\s\S]*disabled:text-\[#593625\]/,
  )
  assert.match(
    source,
    /successButtonClass = `\$\{buttonBaseClass\}[\s\S]*disabled:bg-\[#e5d8bb\][\s\S]*disabled:text-\[#593625\]/,
  )
  assert.match(
    source,
    /dangerButtonClass = `\$\{buttonBaseClass\}[\s\S]*disabled:bg-\[#e5d8bb\][\s\S]*disabled:text-\[#593625\]/,
  )
  assert.doesNotMatch(
    source.match(/export const primaryButtonClass = `[^\n]+/)?.[0] || '',
    /bg-paper|text-ink/,
  )
  assert.doesNotMatch(
    source.match(/export const successButtonClass = `[^\n]+/)?.[0] || '',
    /bg-paper|text-ink/,
  )
  assert.doesNotMatch(
    source.match(/export const dangerButtonClass = `[^\n]+/)?.[0] || '',
    /bg-paper|text-ink/,
  )
})

test('admin pages use high-contrast text, borders, and disabled controls', async () => {
  const styles = await readFile(
    new URL('../src/styles.css', import.meta.url),
    'utf8',
  )
  const login = await readFile(
    new URL('../src/routes/admin_.login.tsx', import.meta.url),
    'utf8',
  )

  assert.match(styles, /data-od-id='admin-page'/)
  assert.match(styles, /data-od-id='admin-login'/)
  assert.match(styles, /--color-muted: #704936/)
  assert.match(styles, /--color-line: #996141/)
  assert.match(styles, /fieldset:disabled[\s\S]*opacity: 1/)
  assert.match(
    styles,
    /button:disabled:not\(\[aria-pressed='true'\]\):not\(\[aria-current\]\)[\s\S]*background: #e5d8bb !important[\s\S]*color: #593625 !important/,
  )
  assert.match(styles, /-webkit-text-fill-color: #593625 !important/)
  assert.match(
    styles,
    /button:disabled:is\(\[aria-pressed='true'\], \[aria-current\]\)[\s\S]*background: #593625 !important[\s\S]*color: #fffaf0 !important/,
  )
  assert.match(
    styles,
    /:is\(button, a\)\.bg-danger:not\(:disabled\)[\s\S]*background-color: #9f2f26 !important[\s\S]*color: #fffaf0 !important/,
  )
  assert.match(login, /data-od-id="admin-login"/)

  const admin = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )
  assert.match(admin, /selectedButtonClass/)
  assert.match(admin, /aria-pressed=\{dashboard\.state\.mode === mode\}/)
  assert.doesNotMatch(admin, /!bg-brown !text-paper/)
})

test('automation jobs expose every server-retryable status', async () => {
  const admin = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    admin,
    /function isRetryableJobStatus[\s\S]*status === 'pending'[\s\S]*status === 'retry_wait'[\s\S]*status === 'leased'[\s\S]*status === 'dead'[\s\S]*status === 'settled'[\s\S]*status === 'degraded'/,
  )
  assert.equal(
    [
      ...admin.matchAll(
        /const retryable = isRetryableJobStatus\(job\.status\)/g,
      ),
    ].length,
    2,
  )
  assert.match(admin, /dispatchTaxonomyOutboxNow/)
  assert.match(admin, /Dispatch pending now/)

  const taxonomyAdmin = await readFile(
    new URL('../src/server/taxonomy-admin.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    taxonomyAdmin,
    /retryJobs\(data\.jobIds\)[\s\S]*dispatchTaxonomyOutbox\(env, \{ limit: 100 \}\)/,
  )
  assert.match(taxonomyAdmin, /export const dispatchTaxonomyOutboxNow/)
})

test('suspense-backed result controls update inside transitions', async () => {
  const directory = await readFile(
    new URL('../src/routes/index.tsx', import.meta.url),
    'utf8',
  )
  const tags = await readFile(
    new URL('../src/routes/tags.tsx', import.meta.url),
    'utf8',
  )
  const admin = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    directory,
    /function changeDirectoryPage[\s\S]*startTransition\(\(\) => setPage\(nextPage\)\)/,
  )
  assert.match(
    directory,
    /function setFilterTags[\s\S]*startTransition\(\(\) => \{[\s\S]*setPage\(0\)[\s\S]*navigate\(/,
  )
  assert.match(
    tags,
    /function changePage[\s\S]*startTransition\(\(\) => setPage\(nextPage\)\)/,
  )
  assert.match(
    admin,
    /function changePage[\s\S]*startTransition\(\(\) => onChange\(nextPage\)\)/,
  )
  assert.equal(
    [
      ...admin.matchAll(
        /onChange=\{\(event\) => \{[\s\S]{0,600}?startTransition\(\(\) => \{/g,
      ),
    ].length,
    8,
  )
  for (const [label, pageSetter] of [
    ['Show status', 'setSubmissionPage'],
    ['Show records', 'setSitePage'],
    ['Candidate status', 'setCandidatePage'],
    ['Candidate kind', 'setCandidatePage'],
    ['Job status', 'setJobPage'],
    ['Job kind', 'setJobPage'],
    ['Batch status', 'setBatchPage'],
    ['Lock state', 'setLockPage'],
  ]) {
    assert.doesNotMatch(
      admin,
      new RegExp(`${label}[\\s\\S]{0,800}?${pageSetter}\\(0\\)`),
    )
  }
  assert.match(
    directory,
    /value=\{sort\}[\s\S]*startTransition\(\(\) => \{[\s\S]*setSort\(event\.target\.value as SortMode\)[\s\S]*setPage\(0\)/,
  )
  assert.match(admin, /createFileRoute\('\/admin'\)\(\{\s*shouldReload: false/)
  assert.match(directory, /createFileRoute\('\/'\)\(\{\s*shouldReload: false/)
  assert.match(tags, /createFileRoute\('\/tags'\)\(\{\s*shouldReload: false/)
  assert.match(
    directory,
    /useQuery\(\{[\s\S]*directoryQueryOptions[\s\S]*placeholderData: keepPreviousData[\s\S]*initialDirectory/,
  )
  assert.match(
    tags,
    /useQuery\(\{[\s\S]*tagPageQueryOptions[\s\S]*placeholderData: keepPreviousData[\s\S]*initialTagPage/,
  )
})

test('public and admin site creation accept optional preview images', async () => {
  const [directory, admin, serverData] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/data.ts', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(directory, /id="submit-image"[\s\S]{0,300}\brequired\b/)
  assert.doesNotMatch(admin, /id="entry-image"[\s\S]{0,300}\brequired\b/)
  assert.match(directory, /Optional\. PNG, JPEG, or WebP, up to 8 MB\./)
  assert.match(admin, /Optional\. PNG, JPEG, or WebP, up to 8 MB\./)
  assert.match(
    serverData,
    /const thumbnail = data\.image \? await storeThumbnail\(data\.image\) : undefined/,
  )
  assert.match(
    serverData,
    /imageValue instanceof File && imageValue\.size > 0 \? imageValue : undefined/,
  )
  assert.match(directory, /if \(!isSubmittedSite\(result\)\)/)
  assert.match(admin, /if \(!isCreatedSite\(result\)\)/)
})

test('policy revisions can be edited into audited successor revisions', async () => {
  const admin = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )

  assert.match(admin, /onClick=\{\(\) => editPolicy\(policy\)\}/)
  assert.match(admin, /supersedesPolicyConfigId: draft\.sourceId/)
  assert.match(admin, /Save as new revision/)
  assert.match(admin, /preserves the selected[\s\S]*revision unchanged/)
})

test('policy activation resets history pagination and backfill reports delivery separately', async () => {
  const admin = await readFile(
    new URL('../src/routes/admin.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    admin,
    /async function activatePolicy[\s\S]*setPolicyPage\(0\)[\s\S]*invalidateTaxonomy\('policies', 'dashboard'\)/,
  )
  assert.match(admin, /enqueued \$\{result\.enqueued\}, and dispatched/)
  assert.match(
    admin,
    /jobs remain pending until the queue consumer processes them/,
  )
})
