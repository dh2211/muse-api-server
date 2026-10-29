'use strict';

const config = require('../config');
const { verifyAdminSession, parseCookies } = require('../utils/adminSession');
const { safeEqual } = require('../utils/crypto');

function requireDashboardAuth(req, res, next) {
  // 1. Check admin_session cookie
  const cookies = parseCookies(req);
  const sessionToken = cookies.admin_session;
  if (sessionToken) {
    const session = verifyAdminSession(sessionToken);
    if (session) {
      req.adminUser = session;
      return next();
    }
  }

  // 2. Check Bearer token or X-Admin-Key header (for scripts or API requests)
  const authHeader = req.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const headerKey = req.get('x-admin-key') || '';
  const candidate = token || headerKey;

  if (candidate && safeEqual(candidate, config.security.adminApiKey)) {
    req.adminUser = { role: 'admin' };
    return next();
  }

  // 3. Unauthenticated handling
  const isApiRequest = req.path.startsWith('/api') || req.originalUrl.includes('/admin/api') || req.xhr || req.headers.accept?.includes('application/json');

  if (isApiRequest) {
    return res.status(401).json({
      error: {
        type: 'authentication_error',
        code: 'unauthorized',
        message: 'Admin authentication required. Please log in.'
      }
    });
  }

  // Redirect browser navigation to the login page
  const returnTo = encodeURIComponent(req.originalUrl || '/admin');
  return res.redirect(`/admin/login?return_to=${returnTo}`);
}

module.exports = {
  requireDashboardAuth
};
