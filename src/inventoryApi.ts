import { configuredApiUrl } from './api'
export async function inventoryRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${configuredApiUrl}/api/inventory${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Inventory unavailable')
  return data as T
}
