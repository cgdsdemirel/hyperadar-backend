'use strict';

const { DuplicateEmailError, InvalidCredentialsError } = require('../utils/errors');

/**
 * AuthController — thin HTTP layer over AuthService.
 * All business logic lives in the service; controllers only translate
 * HTTP in/out and map known errors to appropriate status codes.
 */

/**
 * POST /auth/register
 *
 * Body: { email, password }
 * Success 201: { user: { id, email, plan }, token }
 * Error 400: invalid input
 * Error 409: email already in use
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function register(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { authService } = req.app.locals;
    const { user, token } = await authService.register(email, password);

    return res.status(201).json({ user, token });
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      return res.status(409).json({ error: err.message });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

/**
 * POST /auth/login
 *
 * Body: { email, password }
 * Success 200: { user: { id, email, plan }, token }
 * Error 401: invalid credentials
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { authService } = req.app.locals;
    const { user, token } = await authService.login(email, password);

    return res.status(200).json({ user, token });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
}

module.exports = { register, login };
