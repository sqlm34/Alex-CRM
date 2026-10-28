export function customerName(value: string) {
  const [firstName = '', ...rest] = value.trim().split(/\s+/)
  return { firstName, lastName: rest.join(' ') }
}

export function customerIdentity(job: { customer: string; phone: string; email?: string; address: string }) {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ')
  const name = normalize(job.customer)
  const digits = job.phone.replace(/\D/g, '')
  const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  // A shared/reassigned phone is not enough to merge people or conflicting addresses.
  return JSON.stringify([name, phone || normalize(job.email || ''), normalize(job.address)])
}
