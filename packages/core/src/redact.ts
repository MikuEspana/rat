// Strips secrets that can hide inside error texts (an RPC URL with ?api-key=..., a Telegram bot URL, a database URL
// with a password) before the text is stored in the database, shown on the admin page or sent to Telegram.
const PATTERNS: [RegExp, string][] = [
  [/([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|secret)=)[^&\s"'<>]+/gi, '$1[redacted]'],
  [/(\/bot)\d+:[A-Za-z0-9_-]+/g, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@"'<>]+:[^\s@/"'<>]+@/gi, '$1[redacted]@'],
  [/(\bx-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
