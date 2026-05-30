import type { JobRow } from './supabase'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined

export const isApiConfigured = Boolean(apiUrl)

export type AuthUser = {
  id: string
  email: string
  name: string
  provider: string
}

export type AuthSession = {
  token: string
  user: AuthUser
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function parseApiError(response: Response, fallback: string) {
  let message = fallback

  try {
    const data = (await response.json()) as { error?: string }
    if (data.error) message = data.error
  } catch {
    // Keep the fallback message.
  }

  return new ApiError(message, response.status)
}

export async function fetchJobsFromApi(token?: string) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to load jobs')

  return (await response.json()) as JobRow[]
}

export async function saveJobToApi(job: JobRow, token?: string) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(job),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to save job')

  return (await response.json()) as JobRow
}

export async function updateJobInApi(
  id: string,
  patch: Partial<Pick<JobRow, 'customer' | 'phone' | 'address' | 'paid' | 'status'>>,
  token?: string,
) {
  if (!apiUrl) return

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to update job')
}

export async function deleteJobFromApi(id: string, token?: string) {
  if (!apiUrl) return

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to delete job')
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

export async function loginWithPassword(email: string, password: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to sign in')

  return (await response.json()) as AuthSession
}

export async function registerWithPassword(name: string, email: string, password: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to register')

  return (await response.json()) as AuthSession
}

export async function loginWithGoogle(idToken: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to sign in with Google')

  return (await response.json()) as AuthSession
}

export async function fetchCurrentUser(token: string) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/auth/me`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load profile')

  return (await response.json()) as AuthUser
}
