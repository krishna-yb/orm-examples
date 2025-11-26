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

// Parse the first host from comma-separated list if needed
// Otherwise, simply choose one node for write operations
const parseFirstHost = (hostString) => {
  if (!hostString) return { host: '127.0.0.1', port: 5436 };
  
  // If comma-separated, take first entry
  const firstEntry = hostString.split(',')[0].trim();
  
  // Parse host:port
  const [host, port] = firstEntry.split(':');
  return {
    host: host,
    port: port ? Number(port) : null
  };
};

// Determine the host and port to connect to
// Priority: PGHOST (standard PostgreSQL) > config.json
let host, port;
if (process.env.PGHOST) {
  host = process.env.PGHOST;
  port = process.env.PGPORT ? Number(process.env.PGPORT) : 5436;
} else {
  const parsed = parseFirstHost(baseConfig.host);
  host = parsed.host;
  port = parsed.port || Number(baseConfig.port) || 5436;
}

const database = process.env.PGDATABASE || baseConfig.database || 'ysql_sequelize';
const username = process.env.PGUSER || baseConfig.username || 'yugabyte';
const password = process.env.PGPASSWORD || baseConfig.password || 'yugabyte';

async function ensureDatabase() {
  // Try to connect using the default 'yugabyte' database
  const adminClient = new Client({
    host: host,
    port: port,
    user: username,
    password: password,
    database: 'yugabyte',
  });

  try {
    await adminClient.connect();
    console.log(`Connected to ${host}:${port}`);

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

