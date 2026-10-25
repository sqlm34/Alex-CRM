import { McpError, type Principal } from './security'

type DatabaseEnv = { DATABASE_URL: string; MCP_REVIEW_DATABASE_URL?: string }

// A signed, explicitly allowlisted reviewer must never fall back to live storage.
export function reviewDatabase<T extends DatabaseEnv>(env: T, principal: Principal | null): T {
  if (!principal?.review) return env
  try {
    const live = new URL(env.DATABASE_URL)
    const review = new URL(env.MCP_REVIEW_DATABASE_URL || '')
    if (!['postgres:', 'postgresql:'].includes(review.protocol)
      || !review.hostname || review.hostname === live.hostname) throw Error('isolation')
    return { ...env, DATABASE_URL: review.href }
  } catch { throw new McpError('review_environment_unavailable', 503) }
}
