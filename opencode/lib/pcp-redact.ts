/** Same wire placeholders as openclaw-pcp and the PCP session importer. */
const patterns: Array<[RegExp, string]> = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '<REDACTED:private_key>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <REDACTED>'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, '$1<REDACTED>$2'],
  [/\bpcps_[0-9a-f]{16,}\b/g, '<REDACTED>'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<REDACTED>'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '<REDACTED>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<REDACTED>'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '<REDACTED>'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<REDACTED>'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, '<REDACTED>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<REDACTED:jwt>'],
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1<REDACTED>'],
  [/\b(api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|pwd|passphrase)("?\s*[:=]\s*"?)([^\s"',]{6,})/gi, '$1$2<REDACTED>'],
]
export function redactForPcp(value: string): string {
  for (const [pattern, replacement] of patterns) value = value.replace(pattern, replacement)
  return value
}
