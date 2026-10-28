import { McpError, type Principal } from './security'

type DatabaseEnv = { DATABASE_URL: string; MCP_REVIEW_DATABASE_URL?: string }

function databaseHost(url: URL): string {
  // Neon pooler and direct endpoints can refer to the same database.
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/-pooler(?=\.)/, '')
}

// A signed, explicitly allowlisted reviewer must never fall back to live storage.
export function reviewDatabase<T extends DatabaseEnv>(env: T, principal: Principal | null): T {
  if (!principal?.review) return env
  try {
    const live = new URL(env.DATABASE_URL)
    const review = new URL(env.MCP_REVIEW_DATABASE_URL || '')
    if (!['postgres:', 'postgresql:'].includes(review.protocol)
      || !review.hostname || databaseHost(review) === databaseHost(live)) throw Error('isolation')
    return { ...env, DATABASE_URL: review.href }
  } catch { throw new McpError('review_environment_unavailable', 503) }
}
