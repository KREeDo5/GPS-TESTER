import crypto from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

export function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string' || !header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Bearer-token auth for API routes plus an HttpOnly cookie session for the
 * bundled UI. Disabled when `token` is empty (local-only mode).
 *
 * @param {{ token: string, cookieName: string, label: string }} options
 */
export function createTokenAuth({ token, cookieName, label }) {
  const expected = String(token || '');
  const enabled = expected.length > 0;
  const sessionValue = enabled
    ? crypto.createHmac('sha256', expected).update(`${cookieName}:session`).digest('hex')
    : '';

  function bearerToken(req) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
  }

  function hasSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    return safeEqual(cookies[cookieName] || '', sessionValue);
  }

  function isAuthorized(req) {
    if (!enabled) return true;
    return safeEqual(bearerToken(req), expected) || hasSession(req);
  }

  function middleware(req, res, next) {
    if (isAuthorized(req)) {
      next();
      return;
    }
    res.status(401).json({
      data: null,
      meta: { success: false, error: 'Unauthorized' },
    });
  }

  /**
   * Handle `/?token=...`: set the HttpOnly session cookie and redirect to the
   * clean URL so the token does not stay in browser history or in the address
   * bar. Returns true when the request has already been answered.
   */
  function handleTokenQuery(req, res) {
    if (!enabled) return false;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (!queryToken) return false;
    if (!safeEqual(queryToken, expected)) {
      res.status(401).type('text').send(`${label}: неверный токен`);
      return true;
    }
    res.cookie(cookieName, sessionValue, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect(302, req.path);
    return true;
  }

  return { enabled, middleware, handleTokenQuery };
}
