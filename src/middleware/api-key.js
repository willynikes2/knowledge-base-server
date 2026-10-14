// src/middleware/api-key.js
import { timingSafeEqual } from 'crypto';

const KEY_SERVICES = [
  ['KB_API_KEY_CLAUDE', 'claude'],
  ['KB_API_KEY_OPENAI', 'openai'],
  ['KB_API_KEY_GEMINI', 'gemini'],
  ['KB_API_KEY_SWARM', 'swarm'],
];

/**
 * The service a key belongs to, or null.
 * The key is compared with each configured key by value. It must never be used to look up a property of a
 * plain object: every object inherits "constructor", "toString", "__proto__" and so on, and such a lookup
 * finds them, so those names would pass as valid keys.
 */
export function serviceForKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const given = Buffer.from(key);
  let service = null;
  for (const [envName, name] of KEY_SERVICES) {
    const configured = process.env[envName];
    if (!configured) continue;
    const expected = Buffer.from(configured);
    if (expected.length === given.length && timingSafeEqual(expected, given) && service === null) service = name;
  }
  return service;
}

/**
 * Creates Express middleware that validates API keys from env vars.
 * Checks X-API-Key header or Authorization: Bearer <key>.
 * Sets req.apiService to the service name (claude/openai/gemini/swarm).
 */
export function createApiKeyMiddleware() {
  return (req, res, next) => {
    // Extract key from header
    let key = req.headers['x-api-key'];
    if (!key) {
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        key = auth.slice(7);
      }
    }

    if (!key) {
      return res.status(401).json({ error: 'Missing API key. Provide X-API-Key header or Authorization: Bearer <key>' });
    }

    const service = serviceForKey(key);
    if (!service) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    req.apiService = service;
    next();
  };
}
