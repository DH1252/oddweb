import { useDeferredValue, useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { normalizeTag, tagInputMaxLength, tagsForForm } from '../data/tags'
import { tagSuggestionsQueryOptions } from '../queries/oddweb'

const tagLookupErrorMessage =
  'Could not check tags. Your entered text is still available; try again.'

type TagInputProps = {
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
  initialLabels?: Record<string, string>
}

export function TagInput({
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
  initialLabels = {},
}: TagInputProps) {
  const id = useId()
  const queryClient = useQueryClient()
  const [internalValue, setInternalValue] = useState(defaultValue)
  const selected = value ?? internalValue
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(normalizeTag(query))
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [resolvingTag, setResolvingTag] = useState(false)
  const [requiredError, setRequiredError] = useState(false)
  const [lookupError, setLookupError] = useState<{
    query: string
    message: string
  }>()
  const atLimit = selected.length >= maxTags
  const suggestionQuery = useQuery(
    tagSuggestionsQueryOptions({
      query: deferredQuery,
      selected,
      limit: 8,
    }),
  )
  const { data } = suggestionQuery
  const selectedMetadata = data?.selected || []
  const suggestions = deferredQuery ? data?.suggestions || [] : []
  const recoveredLookup =
    lookupError?.query === deferredQuery && suggestionQuery.isSuccess
  const visibleLookupError =
    (recoveredLookup ? '' : lookupError?.message) ||
    (deferredQuery && suggestionQuery.isError ? tagLookupErrorMessage : '')

  function metadataFor(token: string) {
    const normalized = normalizeTag(token)
    return selectedMetadata.find(
      (tag) =>
        tag.slug === normalized ||
        normalizeTag(tag.name) === normalized ||
        tag.aliases.includes(normalized),
    )
  }

  function labelFor(token: string) {
    if (token.startsWith('~')) return token.slice(1)
    return metadataFor(token)?.name || initialLabels[token] || token
  }

  function update(next: string[]) {
    if (value === undefined) setInternalValue(next)
    if (next.length) setRequiredError(false)
    onChange?.(next)
  }

  function addTag(rawValue?: string) {
    if (atLimit) return
    const input = normalizeTag(rawValue ?? query)
    if (!input) return
    const canonical = [...suggestions, ...selectedMetadata].find(
      (tag) =>
        tag.slug === input ||
        normalizeTag(tag.name) === input ||
        tag.aliases.includes(input),
    )
    const token = canonical?.slug || (allowFreeform ? `~${input}` : undefined)
    if (!token) return
    addToken(token)
  }

  function addToken(token: string) {
    if (atLimit || selected.includes(token)) return
    update([...selected, token])
    setLookupError(undefined)
    setQuery('')
    setOpen(false)
    setActiveIndex(0)
  }

  async function commitEnteredTag() {
    const input = normalizeTag(query)
    if (!input || atLimit || resolvingTag) return

    const visibleSuggestion =
      deferredQuery === input ? suggestions[activeIndex] : undefined
    if (visibleSuggestion) {
      addToken(visibleSuggestion.slug)
      return
    }

    setLookupError(undefined)
    setResolvingTag(true)
    try {
      const result = await queryClient.fetchQuery(
        tagSuggestionsQueryOptions({ query: input, selected, limit: 8 }),
      )
      const suggestion =
        result.suggestions.find(
          (tag) =>
            tag.slug === input ||
            normalizeTag(tag.name) === input ||
            tag.aliases.includes(input),
        ) || result.suggestions.at(0)
      if (suggestion) addToken(suggestion.slug)
      else addTag(input)
    } catch {
      setLookupError({ query: input, message: tagLookupErrorMessage })
    } finally {
      setResolvingTag(false)
    }
  }

  function removeTag(token: string) {
    update(selected.filter((tag) => tag !== token))
  }

  const chipClass =
    tone === 'exclude'
      ? 'border-danger bg-red-50 text-danger'
      : tone === 'include'
        ? 'border-success bg-green-50 text-success'
        : 'border-brown bg-canvas text-ink'

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
                  <span>{labelFor(token)}</span>
                  {freeform ? (
                    <span className="ml-1 text-[10px] uppercase opacity-70">
                      unwrangled
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ml-1 grid min-h-9 min-w-9 place-items-center border-0 bg-transparent text-current hover:bg-ink/10"
                    onClick={() => removeTag(token)}
                    aria-label={`Remove ${labelFor(token)}`}
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
            aria-describedby={`${id}-instructions${requiredError ? ` ${id}-error` : ''}${visibleLookupError ? ` ${id}-lookup-error` : ''}`}
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
            maxLength={tagInputMaxLength}
            onChange={(event) => {
              setQuery(event.target.value)
              setLookupError(undefined)
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
                void commitEnteredTag()
              } else if (event.key === 'Escape') {
                if (!open) return
                event.preventDefault()
                event.stopPropagation()
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
            aria-invalid={
              requiredError || Boolean(visibleLookupError) || undefined
            }
            placeholder={
              atLimit ? `Maximum of ${maxTags} tags reached` : placeholder
            }
            disabled={atLimit || resolvingTag}
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
                      onClick={() => addToken(tag.slug)}
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
              onInvalid={(event) => {
                event.preventDefault()
                setRequiredError(true)
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
      {requiredError ? (
        <p
          id={`${id}-error`}
          className="mt-1 mb-0 border-l-4 border-danger bg-red-50 px-2 py-1 text-sm font-bold text-danger"
          role="alert"
        >
          Add at least one tag before submitting.
        </p>
      ) : null}
      {visibleLookupError ? (
        <p
          id={`${id}-lookup-error`}
          className="mt-1 mb-0 border-l-4 border-danger bg-red-50 px-2 py-1 text-sm font-bold text-danger"
          role="alert"
        >
          {visibleLookupError}
        </p>
      ) : null}
      <p
        id={`${id}-instructions`}
        className="mt-1 mb-0 font-mono text-[11px] text-muted"
      >
        {atLimit
          ? `Maximum of ${maxTags} tags selected. Remove one to add another.`
          : resolvingTag
            ? 'Checking for a canonical tag...'
            : allowFreeform
              ? 'Press Enter/comma to choose the closest canonical suggestion, or add an unwrangled tag when none match.'
              : 'Only canonical tags can be used in directory filters.'}
      </p>
    </div>
  )
}
