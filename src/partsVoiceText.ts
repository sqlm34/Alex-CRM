export type VoiceMode = 'model' | 'part_number' | 'name'

// Convert only explicitly spoken digits, never ambiguous letters (O, I, L).
const digits: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  '\u043d\u043e\u043b\u044c': '0', '\u043d\u0443\u043b\u044c': '0', '\u043e\u0434\u0438\u043d': '1', '\u0434\u0432\u0430': '2', '\u0442\u0440\u0438': '3', '\u0447\u0435\u0442\u044b\u0440\u0435': '4', '\u043f\u044f\u0442\u044c': '5', '\u0448\u0435\u0441\u0442\u044c': '6', '\u0441\u0435\u043c\u044c': '7', '\u0432\u043e\u0441\u0435\u043c\u044c': '8', '\u0434\u0435\u0432\u044f\u0442\u044c': '9',
}

export function partsVoiceText(text: string, mode: VoiceMode): string {
  const trimmed = text.trim()
  if (mode === 'name') return trimmed.slice(0, 200)
  const tokens = trimmed.split(/\s+/).map(token => digits[token.toLowerCase()] ?? token.toUpperCase())
  // Preserve words/ambiguous phrases for review rather than inventing an identifier.
  const identifier = tokens.every(token => /^[A-Z0-9./-]+$/.test(token) && (token.length <= 3 || /\d/.test(token)))
  return (identifier ? tokens.join('') : tokens.join(' ')).slice(0, mode === 'model' ? 100 : 200)
}
