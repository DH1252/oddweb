import { FieldLabel, fieldClass } from '../../components/oddweb'

export function SubmitField({
  label,
  name,
  type = 'text',
  placeholder,
  maxLength,
  autoFocus = false,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  maxLength?: number
  autoFocus?: boolean
}) {
  return (
    <div className="mb-2">
      <FieldLabel htmlFor={`submit-${name}`}>{label}</FieldLabel>
      <input
        id={`submit-${name}`}
        name={name}
        type={type}
        required
        maxLength={maxLength}
        className={fieldClass}
        placeholder={placeholder}
        data-dialog-initial-focus={autoFocus || undefined}
      />
    </div>
  )
}
