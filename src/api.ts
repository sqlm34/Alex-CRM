import type { JobRow } from './supabase'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined

export const isApiConfigured = Boolean(apiUrl)

export async function fetchJobsFromApi() {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load jobs')

  return (await response.json()) as JobRow[]
}

export async function saveJobToApi(job: JobRow) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  })

  if (!response.ok) throw new Error('Unable to save job')

  return (await response.json()) as JobRow
}

export async function updateJobInApi(id: string, patch: Partial<Pick<JobRow, 'paid' | 'status'>>) {
  if (!apiUrl) return

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })

  if (!response.ok) throw new Error('Unable to update job')
}

export async function registerPushToken(token: string, platform: string) {
  if (!apiUrl) return

  const response = await fetch(`${apiUrl}/api/push-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, platform }),
  })

  if (!response.ok) throw new Error('Unable to register push token')
}
