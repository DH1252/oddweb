import { fieldClass } from './oddweb'
import type { ReactNode } from 'react'

export function AutomationMetric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="border border-line bg-paper p-2.5">
      <dt className="font-mono text-[11px] font-bold tracking-wide uppercase">
        {label}
      </dt>
      <dd className="m-0 font-mono text-xl font-bold">{value}</dd>
      <small className="block text-xs text-muted [overflow-wrap:anywhere]">
        {note}
      </small>
    </div>
  )
}

export function AutomationBox({
  title,
  label,
  children,
}: {
  title: string
  label?: string
  children: ReactNode
}) {
  return (
    <section className="min-w-0 border border-line bg-canvas p-2.5">
      <header className="mb-2 flex items-center justify-between gap-2 border-b border-dotted border-brown pb-1.5">
        <h3 className="m-0 font-mono text-sm font-bold uppercase">{title}</h3>
        {label ? (
          <span className="font-mono text-[11px] text-muted">{label}</span>
        ) : null}
      </header>
      {children}
    </section>
  )
}

export function AutomationInput({
  label,
  name,
  type = 'text',
  placeholder,
  defaultValue,
  min,
  max,
  step,
  maxLength,
  autoComplete,
  pattern,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  defaultValue?: string
  min?: string
  max?: string
  step?: string
  maxLength?: number
  autoComplete?: string
  pattern?: string
}) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
        {label}
      </span>
      <input
        className={fieldClass}
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        autoComplete={autoComplete}
        pattern={pattern}
        required
      />
    </label>
  )
}
