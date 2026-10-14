// src/middleware/brain-auth.js
import { createApiKeyMiddleware, serviceForKey } from './api-key.js';

/**
 * The gate in front of the Brain API and the MCP HTTP endpoint: an API key (X-API-Key, or as a Bearer token),
 * or an OAuth access token issued by this server. Anything else gets 401 with the OAuth challenge.
 */
export function createBrainAuth({ verifyAccessToken, challenge }) {
  const apiKeyAuth = createApiKeyMiddleware();
  return async (req, res, next) => {
    // Try API key first (fast path)
    if (req.headers['x-api-key']) {
      return apiKeyAuth(req, res, next);
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      // An API key sent as a Bearer token
      const service = serviceForKey(token);
      if (service) {
        req.apiService = service;
        return next();
      }

      // Otherwise validate as an OAuth access token issued by this server
      const claims = token ? await verifyAccessToken(token) : null;
      if (claims) {
        req.apiService = 'oauth';
        req.oauthClaims = claims;
        return next();
      }
    }

    // RFC 9728: point MCP clients at the metadata that starts the OAuth flow.
    res.setHeader('WWW-Authenticate', challenge());
    return res.status(401).json({ error: 'Missing or invalid authentication. Provide X-API-Key header or OAuth Bearer token.' });
  };
}
