'use strict';

/**
 * Local disk storage for reference uploads and generated outputs, plus
 * HMAC-signed, expiring download URLs.
 *
 * Layout: <STORAGE_DIR>/<purpose>/<yyyy>/<mm>/<dd>/<file_id>.<ext>
 * Writes are atomic (temp file + rename) so readers never see partial files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { File } = require('../models');
const { generateId, hmacSha256, safeEqual } = require('../utils/crypto');
const { EXTENSION_BY_MIME } = require('../utils/mime');
const { ApiError, ErrorCodes } = require('../errors');

async function ensureStorage() {
  await fsp.mkdir(path.join(config.storage.dir, 'reference'), { recursive: true });
  await fsp.mkdir(path.join(config.storage.dir, 'output'), { recursive: true });
  await fsp.mkdir(path.join(config.storage.dir, 'tmp'), { recursive: true });
}

function absolutePath(relativePath) {
  const resolved = path.resolve(config.storage.dir, relativePath);
  // Defense in depth: never escape the storage root.
  if (!resolved.startsWith(path.resolve(config.storage.dir) + path.sep)) {
    throw new ApiError(ErrorCodes.INTERNAL_ERROR, { message: 'Invalid storage path.' });
  }
  return resolved;
}

/**
 * Persists a buffer and creates its File document.
 * @returns {Promise<import('mongoose').Document>}
 */
async function saveFile({ apiKeyId, purpose, kind, mimeType, buffer, filename = null }) {
  const id = generateId('file');
  const now = new Date();
  const ext = EXTENSION_BY_MIME[mimeType] || (kind === 'video' ? 'mp4' : 'bin');
  const dir = path.join(purpose, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  const relativePath = path.join(dir, `${id}.${ext}`).split(path.sep).join('/');
  const target = absolutePath(relativePath);
  const temp = path.join(config.storage.dir, 'tmp', `${id}.part`);

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, target);

  const doc = await File.create({
    _id: id,
    api_key_id: apiKeyId,
    purpose,
    kind,
    mime_type: mimeType,
    bytes: buffer.length,
    filename: filename ? String(filename).slice(0, 255) : null,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    path: relativePath,
    expires_at: new Date(now.getTime() + config.storage.retentionHours * 3600 * 1000)
  });
  return doc;
}

/** Loads a file document (including its private path) or throws 404. */
async function getFileOrThrow(fileId, { apiKeyId = null, param = 'file_id' } = {}) {
  const query = { _id: fileId };
  if (apiKeyId) query.api_key_id = apiKeyId;
  const doc = await File.findOne(query).select('+path').lean();
  if (!doc || doc.expires_at < new Date()) {
    throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such file: '${fileId}'.`, param });
  }
  return doc;
}

async function readFileBuffer(fileDoc) {
  return fsp.readFile(absolutePath(fileDoc.path));
}

async function deleteFile(fileDoc) {
  await fsp.unlink(absolutePath(fileDoc.path)).catch(() => {});
  await File.deleteOne({ _id: fileDoc._id });
}

function signPayload(fileId, expires) {
  return hmacSha256(config.security.signingSecret, `${fileId}.${expires}`, 'base64url');
}

/** Builds an absolute, expiring URL that can be fetched without an API key. */
function createSignedUrl(fileId, ttlSec = config.security.signedUrlTtlSec) {
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const signature = signPayload(fileId, expires);
  return {
    url: `${config.server.publicBaseUrl}/v1/files/${fileId}/content?expires=${expires}&signature=${signature}`,
    expires_at: new Date(expires * 1000).toISOString()
  };
}

function verifySignedUrl(fileId, expires, signature) {
  const exp = Number(expires);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000) || !signature) return false;
  return safeEqual(signPayload(fileId, exp), signature);
}

/**
 * Streams a stored file with HTTP Range support (video seeking), ETag and
 * caching headers handled by Express' sendFile.
 */
function sendStoredFile(res, fileDoc, { download = false } = {}) {
  const abs = absolutePath(fileDoc.path);
  if (!fs.existsSync(abs)) {
    throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `The content of file '${fileDoc._id}' is no longer available.` });
  }
  const ext = EXTENSION_BY_MIME[fileDoc.mime_type] || 'bin';
  const name = fileDoc.filename || `${fileDoc._id}.${ext}`;
  res.setHeader('Content-Type', fileDoc.mime_type);
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return new Promise((resolve, reject) => {
    res.sendFile(abs, { acceptRanges: true, cacheControl: true, maxAge: '1h', immutable: true, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) return reject(err);
      return resolve();
    });
  });
}

module.exports = {
  ensureStorage,
  saveFile,
  getFileOrThrow,
  readFileBuffer,
  deleteFile,
  createSignedUrl,
  verifySignedUrl,
  sendStoredFile,
  absolutePath
};
