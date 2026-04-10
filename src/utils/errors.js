'use strict';

/**
 * Central error classes for HypeRadar.
 *
 * Each error carries a `statusCode` so the global error handler in index.js
 * can respond with the right HTTP status without any controller-level
 * instanceof checks.
 */

class DuplicateEmailError extends Error {
  constructor() {
    super('Email already in use');
    this.name = 'DuplicateEmailError';
    this.statusCode = 409;
  }
}

class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
    this.statusCode = 401;
  }
}

class InvalidTokenError extends Error {
  constructor(message = 'Invalid or expired token') {
    super(message);
    this.name = 'InvalidTokenError';
    this.statusCode = 401;
  }
}

class InsufficientTokensError extends Error {
  constructor(required, available) {
    super(`Insufficient tokens: need ${required}, have ${available}`);
    this.name = 'InsufficientTokensError';
    this.statusCode = 402;
    this.required  = required;
    this.available = available;
    this.remaining = available; // alias used by QueryController response
  }
}

class NotFoundError extends Error {
  constructor(resource = 'Resource') {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class PlanLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanLimitError';
    this.statusCode = 403;
  }
}

class AdCooldownError extends Error {
  constructor(message = 'Please wait before watching another ad') {
    super(message);
    this.name = 'AdCooldownError';
    this.statusCode = 429;
  }
}

class IAPValidationError extends Error {
  constructor(message = 'Invalid receipt') {
    super(message);
    this.name = 'IAPValidationError';
    this.statusCode = 400;
  }
}

class DuplicateReceiptError extends Error {
  constructor() {
    super('Receipt already processed');
    this.name = 'DuplicateReceiptError';
    this.statusCode = 409;
  }
}

module.exports = {
  DuplicateEmailError,
  InvalidCredentialsError,
  InvalidTokenError,
  InsufficientTokensError,
  NotFoundError,
  ValidationError,
  PlanLimitError,
  AdCooldownError,
  IAPValidationError,
  DuplicateReceiptError,
};
