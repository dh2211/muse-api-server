'use strict';

const mongoose = require('mongoose');
const { generateId } = require('../utils/crypto');

const SCOPES = ['chat', 'images', 'videos', 'files', 'admin'];

/**
 * Client API key. The plaintext secret is shown once at creation; only its
 * SHA-256 hash is persisted, so a database leak does not expose usable keys.
 */
const ApiKeySchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateId('key') },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    key_hash: { type: String, required: true, unique: true, select: false },
    key_prefix: { type: String, required: true },
    scopes: { type: [String], enum: SCOPES, default: ['chat', 'images', 'videos', 'files'] },
    enabled: { type: Boolean, default: true },
    expires_at: { type: Date, default: null },
    // null => server default.
    rate_limit_per_minute: { type: Number, default: null, min: 1 },
    max_concurrent_jobs: { type: Number, default: null, min: 1 },
    webhook_secret: { type: String, required: true, select: false },
    last_used_at: { type: Date, default: null },
    usage: {
      requests: { type: Number, default: 0 },
      chat_completions: { type: Number, default: 0 },
      images: { type: Number, default: 0 },
      videos: { type: Number, default: 0 }
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = {
  ApiKey: mongoose.models.ApiKey || mongoose.model('ApiKey', ApiKeySchema),
  SCOPES
};
