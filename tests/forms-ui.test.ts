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

test('semantic button tones override shared hover colors', async () => {
  const source = await readFile(
    new URL('../src/components/oddweb.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /successButtonClass[\s\S]*hover:bg-\[#24592f\]/)
  assert.match(source, /dangerButtonClass[\s\S]*hover:bg-\[#78221c\]/)
})
