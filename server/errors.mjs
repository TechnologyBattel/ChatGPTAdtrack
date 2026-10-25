// Shared error type. Kept in its own module so auth, limits, consent and core
// can all throw the same thing without importing each other.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
