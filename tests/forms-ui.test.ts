import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

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
    /fetchQuery\([\s\S]*tagSuggestionsQueryOptions[\s\S]*addToken\(suggestion\.slug\)[\s\S]*else addTag\(input\)/,
  )
  assert.match(
    source,
    /event\.key === 'Enter'[\s\S]*event\.preventDefault\(\)[\s\S]*commitEnteredTag\(\)/,
  )
})

test('semantic button tones override shared hover colors', async () => {
  const source = await readFile(
    new URL('../src/components/oddweb.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /successButtonClass[\s\S]*hover:bg-\[#24592f\]/)
  assert.match(source, /dangerButtonClass[\s\S]*hover:bg-\[#78221c\]/)
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
  assert.match(styles, /-webkit-text-fill-color: #593625/)
  assert.match(login, /data-od-id="admin-login"/)
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
