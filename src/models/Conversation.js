'use strict';

const mongoose = require('mongoose');
const { generateId } = require('../utils/crypto');

/**
 * Multi-turn chat conversation. Upstream threads are stateful and bound to the
 * account that created them, so the conversation pins `account_id`.
 */
const ConversationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateId('conv') },
    api_key_id: { type: String, required: true },
    account_id: { type: String, required: true },
    session_id: { type: String, required: true },
    title: { type: String, default: null, maxlength: 200 },
    message_count: { type: Number, default: 0 },
    last_message_at: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

ConversationSchema.index({ api_key_id: 1, updated_at: -1 });
ConversationSchema.index({ api_key_id: 1, created_at: -1 });

module.exports = {
  Conversation: mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema)
};
