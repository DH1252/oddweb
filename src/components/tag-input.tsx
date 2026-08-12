import { useDeferredValue, useId, useState } from 'react'

import {
  getCanonicalTag,
  normalizeTag,
  resolveTagSlug,
  tagLabel,
  tagsForForm,
} from '../data/tags'

import type { CanonicalTag } from '../data/tags'

type TagInputProps = {
  catalog: CanonicalTag[]
  label: string
  name?: string
  value?: string[]
  defaultValue?: string[]
  onChange?: (value: string[]) => void
  placeholder?: string
  allowFreeform?: boolean
  tone?: 'include' | 'exclude' | 'neutral'
  required?: boolean
  maxTags?: number
}

export function TagInput({
  catalog,
  label,
  name,
  value,
  defaultValue = [],
  onChange,
  placeholder = 'Start typing a tag...',
  allowFreeform = true,
  tone = 'neutral',
  required = false,
  maxTags = 20,
}: TagInputProps) {
  const id = useId()
  const [internalValue, setInternalValue] = useState(defaultValue)
  const selected = value ?? internalValue
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(normalizeTag(query))
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const atLimit = selected.length >= maxTags
  const selectedCanonical = new Set(
    selected
      .filter((tag) => !tag.startsWith('~'))
      .map((tag) => resolveTagSlug(tag, catalog)),
  )
  const suggestions = deferredQuery
    ? catalog
        .filter(
          (tag) =>
            !selectedCanonical.has(tag.slug) &&
            (normalizeTag(tag.name).includes(deferredQuery) ||
              tag.aliases.some((alias) => alias.includes(deferredQuery))),
        )
        .slice(0, 8)
    : []

  function update(next: string[]) {
    if (value === undefined) setInternalValue(next)
    onChange?.(next)
  }

  function addTag(rawValue?: string) {
    if (atLimit) return
    const input = normalizeTag(rawValue ?? query)
    if (!input) return
    const canonical = getCanonicalTag(input, catalog)
    const token = canonical?.slug || (allowFreeform ? `~${input}` : undefined)
    if (!token || selected.includes(token)) return
    update([...selected, token])
    setQuery('')
    setOpen(false)
    setActiveIndex(0)
  }

  function removeTag(token: string) {
    update(selected.filter((tag) => tag !== token))
  }

  const chipClass =
    tone === 'exclude'
      ? 'border-danger bg-red-50 text-danger'
      : tone === 'include'
        ? 'border-success bg-green-50 text-success'
        : 'border-line bg-canvas text-ink'

  return (
    <div>
      <label
        htmlFor={`${id}-input`}
        className="mb-1 block font-mono text-xs font-bold tracking-[0.06em] uppercase"
      >
        {label}
      </label>
      <div className="border border-brown bg-paper p-1.5 shadow-[inset_1px_1px_0_#d9aa7a]">
        {selected.length ? (
          <ul
            className="mb-1 flex list-none flex-wrap gap-1 p-0"
            aria-label={`${label} selected tags`}
          >
            {selected.map((token) => {
              const freeform = token.startsWith('~')
              return (
                <li
                  key={token}
                  className={`inline-flex min-h-9 items-center border pl-2 font-mono text-xs ${chipClass}`}
                >
                  <span>
                    {freeform ? token.slice(1) : tagLabel(token, catalog)}
                  </span>
                  {freeform ? (
                    <span className="ml-1 text-[10px] uppercase opacity-70">
                      unwrangled
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ml-1 grid min-h-9 min-w-9 place-items-center border-0 bg-transparent text-current hover:bg-ink/10"
                    onClick={() => removeTag(token)}
                    aria-label={`Remove ${freeform ? token.slice(1) : tagLabel(token, catalog)}`}
                  >
                    X
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
        <div className="relative">
          <input
            id={`${id}-input`}
            role="combobox"
            aria-autocomplete="list"
            aria-required={required || undefined}
            aria-describedby={`${id}-instructions`}
            aria-haspopup="listbox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={
              open && suggestions.length ? `${id}-suggestions` : undefined
            }
            aria-activedescendant={
              open && suggestions[activeIndex]
                ? `${id}-option-${activeIndex}`
                : undefined
            }
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
              setActiveIndex(0)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && suggestions.length) {
                event.preventDefault()
                setOpen(true)
                setActiveIndex((index) => (index + 1) % suggestions.length)
              } else if (event.key === 'ArrowUp' && suggestions.length) {
                event.preventDefault()
                setOpen(true)
                setActiveIndex(
                  (index) =>
                    (index - 1 + suggestions.length) % suggestions.length,
                )
              } else if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                addTag(
                  open && suggestions[activeIndex]
                    ? suggestions[activeIndex].slug
                    : undefined,
                )
              } else if (event.key === 'Escape') {
                setOpen(false)
              } else if (
                event.key === 'Backspace' &&
                !query &&
                selected.length
              ) {
                removeTag(selected[selected.length - 1])
              }
            }}
            className="min-h-10 w-full border-0 bg-transparent px-1.5 py-1 text-[15px] outline-none placeholder:text-muted"
            placeholder={
              atLimit ? `Maximum of ${maxTags} tags reached` : placeholder
            }
            disabled={atLimit}
          />
          {open && suggestions.length ? (
            <ul
              id={`${id}-suggestions`}
              role="listbox"
              className="absolute top-full right-0 left-0 z-20 m-0 max-h-64 list-none overflow-y-auto border border-ink bg-paper p-0 shadow-[3px_3px_0_#2a1810]"
            >
              {suggestions.map((tag, index) => {
                const matchingAlias = tag.aliases.find((alias) =>
                  alias.includes(deferredQuery),
                )
                return (
                  <li
                    id={`${id}-option-${index}`}
                    key={tag.slug}
                    role="option"
                    aria-selected={index === activeIndex}
                  >
                    <div
                      className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 border-b border-dotted border-line px-2 py-1.5 text-left last:border-b-0 ${index === activeIndex ? 'bg-canvas' : 'bg-paper hover:bg-canvas'}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addTag(tag.slug)}
                    >
                      <span>
                        <strong className="block font-mono text-xs">
                          {tag.name}
                        </strong>
                        {matchingAlias &&
                        normalizeTag(tag.name) !== deferredQuery ? (
                          <small className="text-muted">
                            {matchingAlias} is a synonym
                          </small>
                        ) : null}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      </div>
      {name ? (
        <>
          <input type="hidden" name={name} value={tagsForForm(selected)} />
          {required ? (
            <input
              type="text"
              value={selected.length ? 'Tags selected' : ''}
              onChange={() => undefined}
              onFocus={(event) => {
                event.currentTarget.parentElement
                  ?.querySelector<HTMLInputElement>('[role="combobox"]')
                  ?.focus()
              }}
              required
              aria-label={`${label} are required`}
              className="absolute size-px opacity-0"
              tabIndex={-1}
            />
          ) : null}
        </>
      ) : null}
      <p
        id={`${id}-instructions`}
        className="mt-1 mb-0 font-mono text-[11px] text-muted"
      >
        {atLimit
          ? `Maximum of ${maxTags} tags selected. Remove one to add another.`
          : allowFreeform
            ? 'Choose a canonical suggestion, or press Enter/comma to add an unwrangled tag.'
            : 'Only canonical tags can be used in directory filters.'}
      </p>
    </div>
  )
}
