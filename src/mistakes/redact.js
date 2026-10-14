// src/mistakes/redact.js — remove secrets from text before it is kept in the ledger.
// The ledger feeds pattern examples, the approval page and agents' briefs, so it uses the session-capture patterns
// (src/capture/terminal.js) plus wider ones for the shapes those miss. Losing a little harmless text is accepted.
import { redact } from '../capture/terminal.js';

const MARK = '[REDACTED]';
const PATTERNS = [
  // A whole private key, or what is left of one.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MARK],
  // A user and password inside a URL: keep the address, drop the credentials.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${MARK}@`],
  // Tokens known by their prefix, including the forms with dashes and underscores.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g, MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, MARK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MARK],
  // "Bearer <token>" and "Authorization: <scheme> <token>".
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${MARK}`],
  // name = value, name: value and "name": "value" (also inside an escaped string), where the name says it is a secret.
  [/((?:\\?["'])?[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*(?:\\?["'])?\s*[=:]\s*)(?:\\?["'])?[^\s"',;\\]{8,}(?:\\?["'])?/gi, `$1${MARK}`],
];

export function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return redact(out);
}
