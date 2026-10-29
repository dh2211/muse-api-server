'use strict';

/**
 * Terminal middleware: 404 / 405 handling and conversion of every thrown
 * error into the standard JSON error envelope.
 */

const { logger } = require('../logger');
const { ApiError, ErrorCodes } = require('../errors');

const log = logger.child({ component: 'http' });

function notFound(req, res, next) {
  next(new ApiError(ErrorCodes.ROUTE_NOT_FOUND, { message: `No endpoint matches ${req.method} ${req.path}. See /docs for the API reference.` }));
}

/** Returns a handler that answers 405 with an Allow header. */
function methodNotAllowed(allowed) {
  return (req, res, next) => {
    res.setHeader('Allow', allowed.join(', '));
    next(new ApiError(ErrorCodes.METHOD_NOT_ALLOWED, { message: `${req.method} is not supported for ${req.path}. Allowed: ${allowed.join(', ')}.` }));
  };
}

/** Maps framework / driver errors onto catalog errors. */
function normalize(err) {
  if (err instanceof ApiError) return err;

  // body-parser
  if (err.type === 'entity.parse.failed') return new ApiError(ErrorCodes.INVALID_JSON, { message: 'The request body is not valid JSON. Check for trailing commas or unquoted keys.' });
  if (err.type === 'entity.too.large') return new ApiError(ErrorCodes.PAYLOAD_TOO_LARGE, { message: `The request body exceeds the ${err.limit ? `${Math.round(err.limit / 1048576)} MB ` : ''}limit. Upload large media via POST /v1/files (multipart) and reference it by file ID.` });
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return new ApiError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, { message: 'Unsupported request body encoding. Use UTF-8 JSON.' });

  // multer
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return new ApiError(ErrorCodes.PAYLOAD_TOO_LARGE, { message: 'The uploaded file exceeds the maximum allowed size.', param: 'file' });
    return new ApiError(ErrorCodes.PARAMETER_INVALID, { message: `Invalid multipart upload: ${err.message}. Send exactly one file in the "file" field.`, param: err.field || 'file' });
  }

  // MongoDB availability
  if (/MongoNetworkError|MongoServerSelectionError|MongooseServerSelectionError|MongoNotConnectedError/.test(err.name || '')) {
    return new ApiError(ErrorCodes.DATABASE_UNAVAILABLE, { retryAfter: 5, cause: err });
  }

  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const apiError = normalize(err) || new ApiError(ErrorCodes.INTERNAL_ERROR, { cause: err });

  if (apiError.status >= 500) {
    const cause = apiError.cause || err;
    const internal = apiError.code === 'internal_error';
    log[internal ? 'error' : 'warn']({ requestId: req.id, code: apiError.code, err: cause?.message, stack: internal ? cause?.stack : undefined }, 'Request failed');
  }

  if (res.headersSent) {
    // Streaming responses already started: terminate the connection.
    res.destroy?.();
    return;
  }

  if (apiError.retryAfter) res.setHeader('Retry-After', String(apiError.retryAfter));
  res.status(apiError.status).json({ error: { ...apiError.toJSON(), request_id: req.id } });
}

module.exports = { notFound, methodNotAllowed, errorHandler, normalize };
