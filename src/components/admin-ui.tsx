import { startTransition } from 'react'

import {
  FieldLabel,
  buttonClass,
  fieldClass,
  primaryButtonClass,
  selectedButtonClass,
} from './oddweb'

export const adminPageSize = 12

export function Stat({
  label,
  value,
  note,
}: {
  label: string
  value: number
  note: string
}) {
  return (
    <div className="min-w-0 border border-line bg-canvas p-2.5">
      <dt className="mb-1 font-mono text-xs font-bold tracking-[0.06em] uppercase">
        {label}
      </dt>
      <dd className="m-0 font-mono text-[clamp(24px,4vw,34px)] leading-none font-bold tracking-[-0.03em]">
        {value.toLocaleString('en')}
      </dd>
      <small className="mt-1.5 block text-xs text-muted">{note}</small>
    </div>
  )
}

export function EditorHeader({
  id,
  eyebrow,
  title,
  onClose,
  disabled,
}: {
  id: string
  eyebrow: string
  title: string
  onClose: () => void
  disabled: boolean
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
      <div>
        <p className="m-0 font-mono text-[11px] text-muted uppercase">
          {eyebrow}
        </p>
        <h2 id={id} className="m-0 font-mono text-base font-bold uppercase">
          {title}
        </h2>
      </div>
      <button
        type="button"
        className={`${buttonClass} min-w-11 px-0`}
        onClick={onClose}
        disabled={disabled}
        aria-label="Close"
      >
        X
      </button>
    </div>
  )
}

export function EditorActions({
  pending,
  onClose,
  submitLabel = 'Save changes',
}: {
  pending: boolean
  onClose: () => void
  submitLabel?: string
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className={buttonClass}
        onClick={onClose}
        disabled={pending}
      >
        Cancel
      </button>
      <button type="submit" className={primaryButtonClass} disabled={pending}>
        {pending ? 'Saving...' : submitLabel}
      </button>
    </div>
  )
}

export function EditorError({ message }: { message: string }) {
  return (
    <p
      className="mb-3 border-l-4 border-danger bg-red-50 px-3 py-2 text-sm font-bold text-danger"
      role="alert"
    >
      {message}
    </p>
  )
}

export function AdminField({
  label,
  name,
  type = 'text',
  placeholder,
  maxLength,
  defaultValue,
  autoFocus = false,
  required = true,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  maxLength?: number
  pattern?: string
  defaultValue?: string
  autoFocus?: boolean
  required?: boolean
}) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className={fieldClass}
        placeholder={placeholder}
        data-dialog-initial-focus={autoFocus || undefined}
      />
    </label>
  )
}

export function AdminTextArea({
  id,
  label,
  name,
  defaultValue,
  maxLength,
  tall = false,
}: {
  id: string
  label: string
  name: string
  defaultValue: string
  maxLength?: number
  tall?: boolean
}) {
  return (
    <div className="mb-2.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <textarea
        id={id}
        name={name}
        aria-label={label}
        defaultValue={defaultValue}
        maxLength={maxLength}
        required
        className={`${fieldClass} ${tall ? 'min-h-32' : 'min-h-24'} resize-y`}
      />
    </div>
  )
}

export function AdminPagination({
  page,
  total,
  pageSize = adminPageSize,
  onChange,
  label,
  focusTargetId,
}: {
  page: number
  total: number
  pageSize?: number
  onChange: (page: number) => void
  label: string
  focusTargetId: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageNumbers = Array.from(
    new Set(
      [0, safePage - 1, safePage, safePage + 1, pageCount - 1].filter(
        (value) => value >= 0 && value < pageCount,
      ),
    ),
  ).sort((a, b) => a - b)
  function changePage(nextPage: number) {
    startTransition(() => onChange(nextPage))
    requestAnimationFrame(() => document.getElementById(focusTargetId)?.focus())
  }
  if (pageCount === 1) return null
  return (
    <nav
      className="mt-2 grid gap-2 border-t border-dotted border-line pt-2 sm:grid-cols-[auto_1fr_auto] sm:items-center"
      aria-label={label}
    >
      <button
        type="button"
        className={buttonClass}
        disabled={safePage === 0}
        onClick={() => changePage(safePage - 1)}
      >
        Previous
      </button>
      <div className="flex flex-wrap items-center justify-center gap-1">
        {pageNumbers.map((number, index) => (
          <span key={number} className="contents">
            {index > 0 && number - pageNumbers[index - 1] > 1 ? (
              <span aria-hidden="true">...</span>
            ) : null}
            <button
              type="button"
              className={`${number === safePage ? selectedButtonClass : buttonClass} min-h-9 min-w-9 px-2`}
              aria-current={number === safePage ? 'page' : undefined}
              onClick={() => changePage(number)}
            >
              {number + 1}
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={safePage >= pageCount - 1}
        onClick={() => changePage(safePage + 1)}
      >
        Next
      </button>
      <span
        className="text-center font-mono text-xs text-muted sm:col-span-3"
        aria-live="polite"
      >
        {safePage * pageSize + 1}-{Math.min(total, (safePage + 1) * pageSize)}{' '}
        of {total} / Page {safePage + 1} of {pageCount}
      </span>
    </nav>
  )
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="border border-dashed border-line bg-canvas px-3 py-6 text-center">
      <h3 className="mb-1 font-mono text-base font-bold">{title}</h3>
      <p className="m-0 text-muted">{text}</p>
    </div>
  )
}
