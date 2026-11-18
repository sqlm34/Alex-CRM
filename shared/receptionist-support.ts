export function supportQueueMatch(call: { support_category?: string | null; callback_status?: string | null }, view: string) {
  if (view === 'Solicitations') return call.callback_status === 'pending' && call.support_category === 'business_solicitation'
  if (view === 'Callbacks') return call.callback_status === 'pending' && call.support_category !== 'business_solicitation'
  return true
}
