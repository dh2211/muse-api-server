'use strict';

const mongoose = require('mongoose');

/**
 * Dynamic system settings stored in database for real-time configuration
 * without requiring server restarts or environment variable modifications.
 */
const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, default: '' }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = {
  Setting: mongoose.models.Setting || mongoose.model('Setting', SettingSchema)
};
