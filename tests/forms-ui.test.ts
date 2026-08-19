import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const adminSourceFiles = [
  'admin-page.tsx',
  'admin-automation-section.tsx',
  'admin-sections/submissions-section.tsx',
  'admin-sections/add-site-section.tsx',
  'admin-sections/site-management-section.tsx',
  'admin-sections/tag-corrections-section.tsx',
  'admin-sections/guestbook-section.tsx',
  'admin-cards.tsx',
  'admin-editors.tsx',
  'admin-ui.tsx',
]

async function readAdminSources() {
  const componentSources = await Promise.all(
    adminSourceFiles.map((file) =>
      readFile(new URL(`../src/components/${file}`, import.meta.url), 'utf8'),
    ),
  )
  const libSources = await Promise.all([
    readFile(new URL('../src/lib/admin-parsers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/admin-format.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/lib/taxonomy-policy-form.ts', import.meta.url),
      'utf8',
    ),
  ])
  return [...componentSources, ...libSources].join('\n')
}

test('timestamps use device-local time after hydration with a UTC fallback', async () => {
  const [admin, localTime] = await Promise.all([
    readAdminSources(),
    readFile(
      new URL('../src/components/local-time.tsx', import.meta.url),
      'utf8',
    ),
  ])
  assert.match(admin, /function formatTimestamp[\s\S]*?timeZone: 'UTC'/)
  assert.match(admin, /<LocalTime[\s\S]*style="dateTime"/)
  assert.match(localTime, /useEffect/)
  assert.match(localTime, /new Intl\.DateTimeFormat\(undefined/)
  assert.doesNotMatch(localTime, /timeZone:/)
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

  const admin = await readAdminSources()
  assert.match(admin, /selectedButtonClass/)
  assert.match(admin, /aria-pressed=\{dashboard\.state\.mode === mode\}/)
  assert.doesNotMatch(admin, /!bg-brown !text-paper/)
})

test('admin audit cards use the available width and wrap opaque identifiers', async () => {
  const [styles, admin] = await Promise.all([
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readAdminSources(),
  ])

  assert.match(styles, /\[data-od-id='admin-page'\]\.odd-shell[\s\S]*1400px/)
  assert.match(admin, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/)
  assert.match(admin, /\[overflow-wrap:anywhere\]/)
  assert.match(
    admin,
    /<section className="min-w-0 border border-line bg-canvas p-2\.5">/,
  )
})

test('automation jobs expose every server-retryable status', async () => {
  const admin = await readAdminSources()

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
  assert.match(taxonomyAdmin, /export const setSiteClassificationEnabled/)
  assert.match(admin, /Disable site classification/)
  assert.match(admin, /Enable site classification/)
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
  const admin = await readAdminSources()
  const adminRoute = await readFile(
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
    assert.match(
      admin,
      new RegExp(`${label}[\\s\\S]{0,800}?${pageSetter}\\(0\\)`),
    )
  }
  assert.match(
    directory,
    /value=\{sort\}[\s\S]*startTransition\(\(\) => \{[\s\S]*setSort\(event\.target\.value as SortMode\)[\s\S]*setPage\(0\)/,
  )
  assert.match(
    adminRoute,
    /createFileRoute\('\/admin'\)\(\{\s*shouldReload: false/,
  )
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

test('surprise navigation requests a fresh filtered site', async () => {
  const [directory, publicData] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/public-data.ts', import.meta.url), 'utf8'),
  ])

  assert.match(
    directory,
    /getPublicSurprise\(\{[\s\S]*query: deferredQuery, include, exclude/,
  )
  assert.match(directory, /disabled=\{surpriseMutation\.isPending\}/)
  assert.doesNotMatch(directory, /directoryData\.surpriseSlug/)
  assert.match(
    publicData,
    /getPublicSurprise = createServerFn\(\{ method: 'POST' \}\)[\s\S]*\.handler\(\(\{ data \}\) => readPublicSurprise\(data\)\)/,
  )
})

test('public and admin site creation accept optional preview images', async () => {
  const [directory, admin, serverData] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readAdminSources(),
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
  assert.match(serverData, /value === null \|\| value === ''/)
  assert.match(directory, /removeEmptyFile\(formData, 'image'\)/)
  assert.match(admin, /removeEmptyFile\(formData, 'image'\)/)
  assert.match(directory, /if \(!isSubmittedSite\(result\)\)/)
  assert.match(admin, /if \(!isCreatedSite\(result\)\)/)
})

test('policy revisions can be edited into audited successor revisions', async () => {
  const admin = await readAdminSources()

  assert.match(admin, /onClick=\{\(\) => editPolicy\(policy\)\}/)
  assert.match(admin, /supersedesPolicyConfigId: draft\.sourceId/)
  assert.match(admin, /Save as new revision/)
  assert.match(admin, /preserves the selected[\s\S]*revision unchanged/)
})

test('policy activation resets history pagination and backfill reports delivery separately', async () => {
  const admin = await readAdminSources()
  assert.match(
    admin,
    /async function activatePolicy[\s\S]*setPolicyPage\(0\)[\s\S]*installControlPlaneSnapshot\(result\)/,
  )
  assert.match(admin, /enqueued \$\{result\.enqueued\}, and dispatched/)
  assert.match(
    admin,
    /jobs remain pending until the queue consumer processes them/,
  )
})

test('mode changes install the authoritative dashboard before UI reconciliation', async () => {
  const admin = await readAdminSources()
  assert.match(
    admin,
    /async function changeMode[\s\S]*modeMutation\.mutateAsync\(mode\)[\s\S]*installDashboard\(result\.dashboard\)/,
  )
  assert.match(admin, /cancelQueries\(\{ queryKey \}\)[\s\S]*invalidateQueries/)
})

test('admin buttons cancel stale reads and install authoritative control-plane snapshots', async () => {
  const [admin, server] = await Promise.all([
    readAdminSources(),
    readFile(
      new URL('../src/server/taxonomy-admin.ts', import.meta.url),
      'utf8',
    ),
  ])
  assert.match(server, /async function controlPlaneSnapshot/)
  assert.match(server, /listTaxonomyProviders\(\{ page: 0, pageSize: 20 \}/)
  assert.match(server, /listTaxonomyPolicies\(\{ page: 0, pageSize: 20 \}/)
  assert.match(
    admin,
    /async function installControlPlaneSnapshot[\s\S]*cancelQueries[\s\S]*setQueryData/,
  )
  assert.doesNotMatch(
    admin.match(/async function invalidateTaxonomy[\s\S]*?\n {2}\}/)?.[0] || '',
    /refetchQueries/,
  )
  assert.match(admin, /const controlPlanePending =/)
  assert.match(admin, /disabled=\{controlPlanePending\}/)
  assert.match(admin, /policyDefaultsKey[\s\S]*items\.slice\(0, 1\)/)
})

test('admin filters reset pagination and editor requests ignore stale responses', async () => {
  const admin = await readAdminSources()
  assert.match(admin, /setSubmissionPage\(0\)[\s\S]*setReviewFilter\(/)
  assert.match(admin, /setSitePage\(0\)[\s\S]*setSiteFilter\(/)
  assert.match(admin, /setCandidatePage\(0\)[\s\S]*setCandidateStatus\(/)
  assert.match(admin, /setJobPage\(0\)[\s\S]*setJobStatus\(/)
  assert.match(admin, /setBatchPage\(0\)[\s\S]*setBatchStatus\(/)
  assert.match(admin, /setLockPage\(0\)[\s\S]*setLockState\(/)
  assert.match(
    admin,
    /const request = \+\+editorRequestRef\.current[\s\S]*request !== editorRequestRef\.current/,
  )
})

test('admin mutations reject false success and protect bundled site status', async () => {
  const [admin, serverData, repository] = await Promise.all([
    readAdminSources(),
    readFile(new URL('../src/server/data.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/db/repository.ts', import.meta.url), 'utf8'),
  ])
  assert.match(admin, /if \(!result\.updated\)[\s\S]{0,100}throw new Error/)
  assert.match(admin, /if \(!result\.released\)[\s\S]{0,100}throw new Error/)
  assert.match(serverData, /z\.enum\(\['active', 'archived'\]\)/)
  assert.match(repository, /Guestbook entry no longer exists/)
  assert.match(
    repository,
    /Bundled directory records cannot change publication status/,
  )
  assert.match(admin, /Published \(bundled record\)/)
})

test('admin data bypasses HTTP caches without destabilizing Suspense queries', async () => {
  const [auth, queries] = await Promise.all([
    readFile(new URL('../src/server/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/queries/oddweb.ts', import.meta.url), 'utf8'),
  ])
  assert.match(auth, /Cache-Control', 'private, no-store, max-age=0'/)
  assert.match(queries, /const adminQueryFreshness = \{[\s\S]*staleTime: 0/)
  assert.match(queries, /gcTime: 5 \* 60_000/)
  assert.match(queries, /refetchOnMount: true/)
  assert.match(queries, /refetchOnReconnect: true/)
  assert.match(queries, /refetchOnWindowFocus: true/)
})

test('admin tag wrangling buttons force relation inference', async () => {
  const [admin, control] = await Promise.all([
    readAdminSources(),
    readFile(
      new URL('../src/server/taxonomy-admin.ts', import.meta.url),
      'utf8',
    ),
  ])
  assert.match(admin, /Force inference/)
  assert.match(admin, /Force unmapped wrangling/)
  assert.match(admin, /Refresh tag associations/)
  assert.match(admin, /forceTagRelationInference\(\{ data: input \}\)/)
  assert.match(admin, /forceUnmappedTagWrangling\(\{ data: \{\} \}\)/)
  assert.match(admin, /refreshTagAssociations\(\{ data: \{\} \}\)/)
  assert.match(
    control,
    /export const forceTagRelationInference = createServerFn\(\{ method: 'POST' \}\)[\s\S]*forceConceptReassessment\(tag\.slug\)/,
  )
  assert.match(
    control,
    /export const forceUnmappedTagWrangling = createServerFn\(\{ method: 'POST' \}\)[\s\S]*canonical = 0/,
  )
  assert.match(
    control,
    /export const refreshTagAssociations = createServerFn\(\{ method: 'POST' \}\)[\s\S]*ORDER BY canonical DESC, id LIMIT 50/,
  )
})

test('honeypot fields protect public forms and server rejects filled honeypots', async () => {
  const [indexRoute, serverData] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/data.ts', import.meta.url), 'utf8'),
  ])

  // Form markup has hidden honeypot inputs
  assert.match(indexRoute, /name="homepage_hp"/)
  assert.match(indexRoute, /name="message_hp"/)
  assert.match(indexRoute, /className="hidden sr-only"/)

  // Server validators reject filled honeypots
  assert.match(serverData, /homepage_hp/)
  assert.match(serverData, /Form validation failed/)
  assert.match(serverData, /Guestbook entry rejected/)
})

test('vote stepped challenge dialog renders Turnstile verification modal', async () => {
  const [indexRoute, siteRoute, voteHook, dialog] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/sites.$slug.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/use-site-vote.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/vote-challenge-dialog.tsx', import.meta.url),
      'utf8',
    ),
  ])

  assert.match(indexRoute, /VoteChallengeDialog/)
  assert.match(siteRoute, /VoteChallengeDialog/)
  assert.match(voteHook, /requestInvisibleTurnstileToken/)
  assert.match(voteHook, /challengeSlug/)
  assert.match(voteHook, /submitChallengeVote/)
  assert.match(dialog, /Quick Verification/)
  assert.match(dialog, /turnstileActions\.vote/)
})
