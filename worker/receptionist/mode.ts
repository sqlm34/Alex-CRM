export type ModeEnv = {
  AI_RECEPTIONIST_DEPLOYMENT?: string
  AI_RECEPTIONIST_LIVE_ENABLED?: string
}

export function liveModeAllowed(env: ModeEnv) {
  return env.AI_RECEPTIONIST_DEPLOYMENT === 'production' && env.AI_RECEPTIONIST_LIVE_ENABLED === 'true'
}

export function settingsModeAllowed(env: ModeEnv, testMode: boolean) {
  return env.AI_RECEPTIONIST_DEPLOYMENT === 'preview' ? testMode : liveModeAllowed(env) && !testMode
}
