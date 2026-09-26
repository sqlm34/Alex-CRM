export function reviewSms(customer: string, phone: string) {
  const firstName = customer.trim().split(/\s+/)[0]
  if (!firstName) throw new Error('Cannot prepare review request. Customer name is missing.')
  const normalized = phone.trim().replace(/[\s().-]/g, '')
  if (!/^\+?\d{10,15}$/.test(normalized)) throw new Error('Cannot open SMS. Customer phone number is missing.')
  return {
    firstName,
    phone: normalized,
    text: `${firstName}, I would really appreciate it if you would leave a review in my google business account. Thank you!!!\nhttps://g.page/r/CSFvvmB61pviEAE/review\nThank you in advance. Have a good day.`,
  }
}
