'use strict';

const mongoose = require('mongoose');
const { generateId } = require('../utils/crypto');

/**
 * Stored media object: either an uploaded reference (purpose "reference") or a
 * generated output (purpose "output"). Binary content lives on disk; this
 * document is the metadata index.
 */
const FileSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateId('file') },
    api_key_id: { type: String, required: true, index: true },
    purpose: { type: String, enum: ['reference', 'output'], required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    mime_type: { type: String, required: true },
    bytes: { type: Number, required: true },
    filename: { type: String, default: null },
    sha256: { type: String, required: true },
    path: { type: String, required: true, select: false },
    expires_at: { type: Date, required: true, index: true }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, versionKey: false }
);

// Newest-first listing per API key.
FileSchema.index({ api_key_id: 1, created_at: -1 });

module.exports = {
  File: mongoose.models.File || mongoose.model('File', FileSchema)
};
