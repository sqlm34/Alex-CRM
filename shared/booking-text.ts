/** Remove only repeated postal suffixes, never a matching house/unit number. */
export function singleZipAddress(address: string): string {
  const country = address.match(/,?\s+(USA|US|United States(?: of America)?)\s*$/i)
  let value = (country ? address.slice(0, country.index) : address).trim().replace(/,\s*$/, '')
  for (;;) {
    const last = value.match(/([,\s]+)(\d{5}(?:-\d{4})?)$/)
    if (!last) break
    const prefix = value.slice(0, last.index)
    const previous = prefix.match(/([,\s]+)(\d{5}(?:-\d{4})?)$/)
    if (!previous || previous[2].slice(0, 5) !== last[2].slice(0, 5)) break
    if (previous[2].length > 5 && last[2].length > 5 && previous[2] !== last[2]) break
    const zip = previous[2].length > 5 ? previous[2] : last[2]
    value = prefix.slice(0, previous.index) + previous[1] + zip
  }
  return value + (country ? `, ${country[1]}` : '')
}

export function serviceBookingAddress(address: string, zip: string): string {
  const clean = singleZipAddress(address)
  const postal = clean.match(/(?:^|[,\s])(\d{5})(?:-\d{4})?(?:,?\s+(?:USA|US|United States(?: of America)?))?$/i)
  if (postal) {
    if (postal[1] !== zip) throw new Error('Address ZIP does not match the confirmed ZIP')
    return clean
  }
  return `${clean}, ${zip}`
}

/** Historical generated attachment labels are presentation metadata, not symptoms. */
export function customerDescription(issue: string): string {
  return issue.replace(/(?:\r?\n){1,2}(?:Model sticker photo\(s\):[^\r\n]*|(?:Attached photos?|Photos? attached)(?::[^\r\n]*)?\.?)[ \t]*(?=$|\r?\n)/gi, '').trimEnd()
}
