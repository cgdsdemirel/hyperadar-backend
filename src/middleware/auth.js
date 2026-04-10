'use strict';

/**
 * JWT authentication middleware.
 *
 * Expects: Authorization: Bearer <token>
 *
 * On success → attaches decoded payload to req.user, calls next().
 * On failure → responds 401 { error: 'Unauthorized' } immediately.
 *
 * Note: authService is injected via req.app.locals so this middleware
 * stays stateless and testable without module-level singletons.
 */

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authenticate(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.slice(7); // strip 'Bearer '

  try {
    const { authService } = req.app.locals;
    const payload = authService.verifyToken(token);
    req.user = { id: payload.sub };
    next();
  } catch {
    // InvalidTokenError or any jwt error — always 401, never leak details
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { authenticate };
