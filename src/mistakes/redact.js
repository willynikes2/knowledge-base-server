// src/mistakes/redact.js — remove secrets from text before it is kept in the ledger.
// The ledger feeds pattern examples, the approval page and agents' briefs, so it uses the session-capture patterns
// (src/capture/terminal.js) plus wider ones for the shapes those miss. Losing a little harmless text is accepted.
import { redact } from '../capture/terminal.js';

const MARK = '[REDACTED]';
const PATTERNS = [
  // A whole private key, or what is left of one.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MARK],
  // A user and password inside a URL: keep the address, drop the credentials.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi, `$1${MARK}@`],
  // Tokens known by their prefix, including the forms with dashes and underscores.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g, MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, MARK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MARK],
  // "Bearer <token>" and "Authorization: <scheme> <token>".
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${MARK}`],
  // name = value, name: value and "name": "value" (also inside an escaped string), where the name says it is a secret.
  // The name around the secret word is bounded ({0,40}), so a long run of letters is scanned in linear time.
  [/((?:\\?["'])?[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]{0,40}(?:\\?["'])?[ \t]{0,10}[=:][ \t]{0,10})(?:\\?["'])?[^\s"',;\\]{8,512}(?:\\?["'])?/gi, `$1${MARK}`],
];

// Every kept field is at most a few kilobytes, so text far past this point is never kept. Cutting it before the
// patterns run keeps one huge request from stalling the server.
export const MAX_REDACT_INPUT = 64 * 1024;

export function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  if (out.length > MAX_REDACT_INPUT) {
    const cut = out.lastIndexOf('\n', MAX_REDACT_INPUT);
    out = out.slice(0, cut > MAX_REDACT_INPUT / 2 ? cut : MAX_REDACT_INPUT);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return redact(out);
}
