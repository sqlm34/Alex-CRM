import { useEffect, useState } from 'react'
import { FileImage } from 'lucide-react'
import { fetchJobAttachments, type JobAttachmentMetadata } from './api'

export function AttachmentHistory({ jobId, token, onOpen }: {
  jobId: string
  token?: string
  onOpen: (photo: JobAttachmentMetadata) => void
}) {
  const [files, setFiles] = useState<JobAttachmentMetadata[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    setError('')
    void fetchJobAttachments(jobId, token, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setFiles((result.archivedAttachments || []).sort((a, b) => String(b.hidden_at).localeCompare(String(a.hidden_at))))
        setLoaded(true)
      }
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load attachment history')
    })
    return () => controller.abort()
  }, [jobId, token, attempt])
  return <section aria-label="Attachment history">
    <h3>Attachment history</h3>
    {error ? <><p role="alert">{error}</p><button type="button" className="secondary-action" onClick={() => setAttempt(value => value + 1)}>Retry</button></> : !loaded ? <p role="status">Loading history...</p> : files.length ? files.map(file => (
      <article className="receipt-entry" key={file.id}>
        <strong>{file.display_name || file.original_filename}</strong>
        <small>Hidden from Attachments: {file.hidden_at ? new Date(file.hidden_at).toLocaleString('en-US') : ''}</small>
        <button type="button" className="secondary-action" onClick={() => onOpen(file)}><FileImage size={16} />View file</button>
      </article>
    )) : <p>No archived attachments</p>}
  </section>
}
