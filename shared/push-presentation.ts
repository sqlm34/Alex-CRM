export function jobPushPresentation(event: string, source: string | null | undefined, detail: string | null | undefined, title: string) {
  if (event !== 'created') return { title, icon: 'ic_stat_alex_notification' }
  if (detail === 'mcp_assistant') return { title: 'AI assistant · New booking', icon: 'ic_stat_site_booking' }
  if (detail === 'phone_assistant') return { title: 'Phone Emily · New booking', icon: 'ic_stat_phone_assistant' }
  if (detail === 'voice_assistant') return { title: 'Book by Voice · New booking', icon: 'ic_stat_site_booking' }
  if (source === 'website' || source === 'google' || source === 'google_maps') return { title: 'Site booking · New order', icon: 'ic_stat_site_booking' }
  return { title, icon: 'ic_stat_alex_notification' }
}
