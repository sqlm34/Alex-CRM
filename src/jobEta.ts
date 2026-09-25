export function etaRecipient(customer: string, phone: string, address: string) {
  if (!address.trim()) throw new Error('Cannot calculate ETA. Customer address is missing.')
  const normalized = phone.trim().replace(/[\s().-]/g, '')
  if (!/^\+?\d{10,15}$/.test(normalized)) throw new Error('Cannot open SMS. Customer phone number is missing.')
  const firstName = customer.trim().split(/\s+/)[0]
  if (!firstName) throw new Error('Cannot prepare ETA. Customer name is missing.')
  return { firstName, phone: normalized, address: address.trim() }
}

export function etaMessage(firstName: string, durationMillis: number) {
  if (!Number.isFinite(durationMillis) || durationMillis < 0) throw new Error('Cannot calculate ETA. Route duration is unavailable.')
  const fromMinutes = Math.ceil(durationMillis / 300000) * 5
  const toMinutes = fromMinutes + 5
  return { fromMinutes, toMinutes, text: `Hello, ${firstName}. I'm on the way, I'll be there in ${fromMinutes}-${toMinutes} minutes. Thanks.` }
}

export async function drivingDuration(address: string): Promise<number> {
  if (!navigator.geolocation) throw new Error('Current location is unavailable on this device.')
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, (error) => reject(new Error(error.code === 1
      ? 'Allow location access in device and app settings to calculate ETA.'
      : 'Cannot obtain current location. Please try again.')), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
  })
  if (!Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)
    || position.coords.accuracy > 1000 || Date.now() - position.timestamp > 60000) {
    throw new Error('Current location is not accurate enough. Please try again.')
  }
  if (typeof google === 'undefined' || !google.maps?.importLibrary) throw new Error('Maps are unavailable. Please try again.')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const { Route } = await google.maps.importLibrary('routes') as google.maps.RoutesLibrary
        const result = await Route.computeRoutes({
          origin: { lat: position.coords.latitude, lng: position.coords.longitude },
          destination: address,
          travelMode: 'DRIVING',
          routingPreference: 'TRAFFIC_AWARE',
          // Omit departureTime: Google uses request time, independent of device clock skew.
          fields: ['durationMillis'],
        })
        const duration = result.routes?.[0]?.durationMillis
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new Error('No route')
        return duration
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), 20000) }),
    ])
  } catch {
    throw new Error('Cannot calculate driving ETA. Check the address and routing service, then try again.')
  } finally {
    clearTimeout(timer)
  }
}
