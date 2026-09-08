export type CapabilitiesDiagnostic = {
  status: 'supported' | 'update-required' | 'unavailable'
  protocolVersion: number | null
  externalClientSecret: boolean | null
}

export async function checkStripeCapabilities(
  available: boolean,
  getCapabilities: () => Promise<unknown>,
  timeoutMs = 8000,
): Promise<CapabilitiesDiagnostic> {
  const unavailable: CapabilitiesDiagnostic = {
    status: 'unavailable', protocolVersion: null, externalClientSecret: null,
  }
  if (!available) return unavailable
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      getCapabilities(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      }),
    ])
    if (!response || typeof response !== 'object') return unavailable
    const values = response as Record<string, unknown>
    const version = values.stripePaymentProtocolVersion
    const supported = values.supportsExternalClientSecret
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof supported !== 'boolean') {
      return unavailable
    }
    return {
      status: version >= 2 && supported === true ? 'supported' : 'update-required',
      protocolVersion: version,
      externalClientSecret: supported,
    }
  } catch {
    // Native errors can contain sensitive details; never return them to the UI.
    return unavailable
  } finally {
    clearTimeout(timer)
  }
}
