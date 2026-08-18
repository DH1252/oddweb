import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { createDirectorySite } from '../../server/data'
import { FieldLabel, Panel, fieldClass, primaryButtonClass } from '../oddweb'
import { AdminField } from '../admin-ui'
import { TagInput } from '../tag-input'
import { isCreatedSite, removeEmptyFile } from '../../lib/admin-parsers'

import type { FormEvent } from 'react'

export function AddSiteSection({
  refresh,
  showStatus,
  handleAdminError,
  onDirectoryChanged,
}: {
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
  onDirectoryChanged: () => void
}) {
  const [entryTagInputKey, setEntryTagInputKey] = useState(0)
  const createMutation = useMutation({
    mutationFn: (form: FormData) => createDirectorySite({ data: form }),
  })

  async function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    removeEmptyFile(formData, 'image')
    const name = String(formData.get('name') || '').trim()
    showStatus(`Adding "${name}"...`)
    try {
      const result: unknown = await createMutation.mutateAsync(formData)
      if (!isCreatedSite(result)) {
        throw new Error('The site was not created.')
      }
      onDirectoryChanged()
      await refresh()
      form.reset()
      setEntryTagInputKey((key) => key + 1)
      showStatus(`Added "${name}".`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not add the site.'),
        'error',
      )
    }
  }

  return (
    <Panel title="Add site">
      <form onSubmit={addEntry}>
        <fieldset
          disabled={createMutation.isPending}
          className="m-0 min-w-0 border-0 p-0"
        >
          <AdminField
            label="Site name"
            name="name"
            placeholder="Name as it should appear"
            maxLength={60}
          />
          <AdminField
            label="Website address"
            name="url"
            type="url"
            placeholder="https://"
          />
          <div className="mb-2.5 border border-dotted border-brown bg-canvas p-2">
            <FieldLabel htmlFor="entry-image">Site preview image</FieldLabel>
            <input
              id="entry-image"
              name="image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="w-full"
            />
            <small className="mt-1 block text-muted">
              Optional. PNG, JPEG, or WebP, up to 8 MB.
            </small>
          </div>
          <div className="mb-2.5">
            <FieldLabel htmlFor="entry-description">
              Card description
            </FieldLabel>
            <textarea
              id="entry-description"
              name="description"
              maxLength={220}
              required
              className={`${fieldClass} min-h-24 resize-y`}
            />
          </div>
          <div className="mb-2.5">
            <TagInput
              key={entryTagInputKey}
              label="Tags"
              name="tags"
              required
              placeholder="Try audio, playful, tool..."
            />
          </div>
          <label className="mb-2.5 block">
            <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
              Initial status
            </span>
            <select name="status" className={fieldClass}>
              <option value="active">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button type="submit" className={primaryButtonClass}>
            {createMutation.isPending ? 'Adding...' : 'Add site'}
          </button>
        </fieldset>
      </form>
    </Panel>
  )
}
