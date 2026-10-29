'use strict';

/**
 * Request validation with zod. Failures produce a single 400 response that
 * lists every problem, e.g.:
 *
 *   {
 *     "error": {
 *       "type": "invalid_request_error",
 *       "code": "validation_failed",
 *       "message": "prompt: Required.",
 *       "param": "prompt",
 *       "details": [{ "param": "prompt", "issue": "invalid_type", "message": "Required." }]
 *     }
 *   }
 *
 * Parsed (coerced, defaulted) values are exposed on `req.valid[source]`.
 */

const { ApiError, ErrorCodes } = require('../errors');

function formatPath(path) {
  return path.reduce((acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg)), '');
}

function describeIssue(issue) {
  if (issue.code === 'invalid_type' && /received undefined/i.test(issue.message)) return 'Required.';
  if (issue.code === 'unrecognized_keys') return `Unknown parameter(s): ${issue.keys.join(', ')}.`;
  const msg = issue.message.replace(/^Invalid input: /, '');
  const sentence = msg.charAt(0).toUpperCase() + msg.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * @param {import('zod').ZodType} schema
 * @param {'body'|'query'|'params'} [source]
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const input = source === 'body' && (req.body === undefined || req.body === null) ? {} : req[source];
    const result = schema.safeParse(input);
    if (!result.success) {
      const details = result.error.issues.slice(0, 20).map((issue) => ({
        param: formatPath(issue.path) || null,
        issue: issue.code,
        message: describeIssue(issue)
      }));
      const first = details[0];
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, {
        message: first ? `${first.param ? `${first.param}: ` : ''}${first.message}` : undefined,
        param: first?.param || null,
        details
      });
    }
    req.valid = req.valid || {};
    req.valid[source] = result.data;
    next();
  };
}

module.exports = { validate };
