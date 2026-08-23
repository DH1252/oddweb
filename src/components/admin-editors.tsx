import { TagInput } from './tag-input'
import {
  FieldLabel,
  ItemThumbnail,
  ModalDialog,
  buttonClass,
  fieldClass,
} from './oddweb'
import {
  AdminField,
  AdminTextArea,
  EditorActions,
  EditorError,
  EditorHeader,
} from './admin-ui'

import type { FormEvent } from 'react'
import type { AdminSite, AdminTagRecord } from '../db/repository'

export function SiteEditor({
  entry,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  entry: AdminSite
  pending: boolean
  error: string
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ModalDialog
      labelledBy="edit-entry-title"
      onClose={onClose}
      closeDisabled={pending}
    >
      <form
        className="my-auto w-full max-w-2xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
        onSubmit={onSubmit}
      >
        <EditorHeader
          id="edit-entry-title"
          eyebrow={`Site #${entry.id}`}
          title={`Edit ${entry.name}`}
          onClose={onClose}
          disabled={pending}
        />
        {error ? <EditorError message={error} /> : null}
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          <input type="hidden" name="id" value={entry.id} />
          <div className="grid gap-3 md:grid-cols-[1fr_180px]">
            <div>
              <AdminField
                label="Site name"
                name="name"
                placeholder="Name as it should appear"
                maxLength={60}
                defaultValue={entry.name}
                autoFocus
              />
              <AdminField
                label="Website address"
                name="url"
                type="url"
                placeholder="https://"
                defaultValue={entry.externalUrl}
              />
            </div>
            <div>
              <p className="mb-1 font-mono text-xs font-bold tracking-wide uppercase">
                Current thumbnail
              </p>
              <ItemThumbnail
                thumbnailKey={entry.thumbnailKey}
                alt={entry.thumbnailAlt || `Preview of ${entry.name}`}
                label={entry.name}
                className="aspect-4/3 w-full"
              />
            </div>
          </div>
          <AdminTextArea
            id="edit-entry-description"
            label="Card description"
            name="description"
            defaultValue={entry.description}
            maxLength={220}
          />
          <AdminTextArea
            id="edit-entry-summary"
            label="Detail summary"
            name="summary"
            defaultValue={entry.summary}
            maxLength={400}
          />
          <div className="grid gap-2 md:grid-cols-2">
            <AdminField
              label="Categories"
              name="categories"
              placeholder="Interactive, Audio"
              defaultValue={entry.categories.join(', ')}
            />
            <AdminField
              label="Credit"
              name="poster"
              placeholder="Submitted by..."
              maxLength={120}
              defaultValue={entry.poster}
            />
          </div>
          <AdminTextArea
            id="edit-entry-notes"
            label="Detail notes"
            name="notes"
            defaultValue={entry.notes.join('\n')}
            tall
          />
          <AdminTextArea
            id="edit-entry-facts"
            label="Facts"
            name="facts"
            defaultValue={entry.facts
              .map((fact) => `${fact.label}: ${fact.value}`)
              .join('\n')}
            tall
          />
          <div className="grid gap-2 md:grid-cols-2">
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                Accent
              </span>
              <select
                name="accent"
                defaultValue={entry.accent}
                className={fieldClass}
              >
                {accentOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <AdminField
              label="Thumbnail alt text"
              name="thumbnailAlt"
              placeholder="Describe the image"
              maxLength={180}
              defaultValue={entry.thumbnailAlt || `Preview of ${entry.name}`}
            />
          </div>
          <div className="mb-2.5 border border-dotted border-brown bg-canvas p-2">
            <FieldLabel htmlFor="edit-entry-image">
              Replace thumbnail
            </FieldLabel>
            <input
              id="edit-entry-image"
              name="image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Replace thumbnail"
              className="w-full"
            />
            <small className="mt-1 block text-muted">
              Leave empty to keep the current image.
            </small>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_180px]">
            <div className="mb-2.5">
              <TagInput
                key={entry.id}
                label="Tags"
                name="tags"
                required
                defaultValue={entry.tags}
                initialLabels={entry.tagLabels}
              />
            </div>
            {entry.source === 'Directory' ? (
              <div className="mb-2.5 block">
                <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                  Status
                </span>
                <input type="hidden" name="status" value={entry.status} />
                <p className="m-0 min-h-11 border border-line bg-canvas px-3 py-2">
                  Published (bundled record)
                </p>
              </div>
            ) : (
              <label className="mb-2.5 block">
                <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                  Status
                </span>
                <select
                  name="status"
                  defaultValue={entry.status}
                  className={fieldClass}
                >
                  <option value="active">Published</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            )}
          </div>
          <EditorActions pending={pending} onClose={onClose} />
        </fieldset>
      </form>
    </ModalDialog>
  )
}

export function TagEditor({
  tag,
  mergeTarget,
  onMergeTarget,
  pending,
  error,
  onClose,
  onSubmit,
  onMerge,
}: {
  tag: AdminTagRecord
  mergeTarget: string
  onMergeTarget: (value: string) => void
  pending: boolean
  error: string
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onMerge: () => void
}) {
  return (
    <ModalDialog
      labelledBy="edit-tag-title"
      onClose={onClose}
      closeDisabled={pending}
    >
      <form
        className="my-auto w-full max-w-xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
        onSubmit={onSubmit}
      >
        <EditorHeader
          id="edit-tag-title"
          eyebrow={`${tag.canonical ? 'Canonical' : 'Unmapped'} / ${tag.slug}`}
          title={`Edit ${tag.name}`}
          onClose={onClose}
          disabled={pending}
        />
        {error ? <EditorError message={error} /> : null}
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          <AdminField
            label="Display name"
            name="name"
            placeholder="Canonical display name"
            defaultValue={tag.name}
            maxLength={80}
            autoFocus
          />
          <AdminField
            label="Aliases"
            name="aliases"
            placeholder="audio, sounds, relaxing"
            defaultValue={tag.aliases.join(', ')}
            required={false}
          />
          <AdminField
            label="Parent tag slugs"
            name="parents"
            placeholder="listen, wander"
            defaultValue={tag.parents.join(', ')}
            required={false}
          />
          {!tag.canonical ? (
            <div className="mb-3 border border-dotted border-line bg-canvas p-2">
              <FieldLabel htmlFor="merge-target">
                Merge into canonical slug
              </FieldLabel>
              <div className="flex flex-wrap gap-2">
                <input
                  id="merge-target"
                  value={mergeTarget}
                  onChange={(event) => onMergeTarget(event.target.value)}
                  className={`${fieldClass} min-w-0 flex-1`}
                  placeholder="canonical-tag"
                />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!mergeTarget.trim() || pending}
                  onClick={onMerge}
                >
                  Merge
                </button>
              </div>
            </div>
          ) : null}
          <EditorActions
            pending={pending}
            onClose={onClose}
            submitLabel={tag.canonical ? 'Save tag' : 'Make canonical'}
          />
        </fieldset>
      </form>
    </ModalDialog>
  )
}

const accentOptions = [
  ['from-[#63396d] to-[#d27a3e]', 'Purple / orange'],
  ['from-[#315c51] to-[#79a381]', 'Green'],
  ['from-[#38578d] to-[#eabc52]', 'Blue / gold'],
  ['from-[#527797] to-[#d8a866]', 'Sky / sand'],
  ['from-[#dc4f33] to-[#e9b640]', 'Red / gold'],
  ['from-[#586f44] to-[#c4a866]', 'Olive / sand'],
  ['from-[#5b376b] to-[#b06970]', 'Purple / rose'],
  ['from-[#704d3f] to-[#d28f61]', 'Brown / orange'],
  ['from-[#42687c] to-[#8ca8aa]', 'Blue / gray'],
  ['from-[#8d3b2b] to-[#d37237]', 'Rust / orange'],
] as const
