/**
 * Strips invisible control characters (zero-width, RTL/LTR overrides,
 * bidi isolates, BOM) and trims whitespace.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim()
}
