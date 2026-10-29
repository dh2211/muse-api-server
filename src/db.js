'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const { logger } = require('./logger');

const log = logger.child({ component: 'database' });

mongoose.set('strictQuery', true);

/**
 * Connects to MongoDB with bounded retries so a container that starts before
 * the database is ready does not crash-loop immediately.
 */
async function connectDatabase({ retries = 10, delayMs = 3000 } = {}) {
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => log.error({ err: err.message }, 'MongoDB connection error'));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(config.database.uri, {
        maxPoolSize: config.database.maxPoolSize,
        serverSelectionTimeoutMS: 10000,
        autoIndex: true
      });
      log.info({ host: mongoose.connection.host, db: mongoose.connection.name }, 'MongoDB connected');
      return mongoose.connection;
    } catch (err) {
      log.error({ attempt, retries, err: err.message }, 'MongoDB connection attempt failed');
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

async function disconnectDatabase() {
  await mongoose.disconnect().catch(() => {});
}

module.exports = { connectDatabase, disconnectDatabase, isDatabaseReady };
