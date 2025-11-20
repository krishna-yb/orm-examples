#!/usr/bin/env node

/**
 * Ensures the database exists before starting the application.
 * Similar to "CREATE DATABASE IF NOT EXISTS" behavior.
 */

// Use @yugabytedb/pg if available, otherwise fall back to standard pg
let Client;
try {
  Client = require('@yugabytedb/pg').Client;
} catch (e) {
  Client = require('pg').Client;
}
const path = require('path');

const env = process.env.NODE_ENV || 'development';
const baseConfig = require(path.join(__dirname, 'config', 'config.json'))[env];

// Parse YB_HOSTS or use config defaults
const parseHosts = (rawHosts) => {
  if (!rawHosts) {
    return [{ host: baseConfig.host || '127.0.0.1', port: Number(baseConfig.port) || 5436 }];
  }
  return rawHosts
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [host, port = baseConfig.port || '5436'] = entry.split(':');
      return { host, port: Number(port) };
    });
};

const HOSTS = process.env.YB_HOSTS 
  ? parseHosts(process.env.YB_HOSTS)
  : parseHosts(`${baseConfig.host || '127.0.0.1'}:${baseConfig.port || 5436}`);

const database = baseConfig.database || 'ysql_sequelize';
const username = baseConfig.username || 'yugabyte';
const password = baseConfig.password || 'yugabyte';

async function ensureDatabase() {
  // Try to connect to the first host using the default 'yugabyte' database
  const primaryHost = HOSTS[0];
  const adminClient = new Client({
    host: primaryHost.host,
    port: primaryHost.port,
    user: username,
    password: password,
    database: 'yugabyte',
  });

  try {
    await adminClient.connect();
    console.log(`Connected to ${HOSTS[0].host}:${HOSTS[0].port}`);

    // Check if database exists
    const result = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [database]
    );

    if (result.rows.length === 0) {
      // Database doesn't exist, create it
      console.log(`Creating database "${database}"...`);
      // 
      await adminClient.query(`CREATE DATABASE ${database}`);
      console.log(`Database "${database}" created successfully`);
    } else {
      console.log(`Database "${database}" already exists`);
    }

    await adminClient.end();
    return true;
  } catch (error) {
    console.error(`Error ensuring database: ${error.message}`);
    await adminClient.end().catch(() => {});
    return false;
  }
}

// Run if called directly
if (require.main === module) {
  ensureDatabase()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { ensureDatabase };

