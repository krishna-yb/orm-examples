require('dotenv').config();

'use strict';

/**
 * Smart‑driver aware Sequelize bootstrap for YugabyteDB.
 *
 * Configuration via environment variables (in order of precedence):
 * 
 * 1. Standard PostgreSQL variables:
 *    - PGHOST: Single database host (e.g., "127.0.0.1")
 *    - PGPORT: Database port (default: 5436)
 *    - PGUSER: Database user (default: yugabyte)
 *    - PGPASSWORD: Database password (default: yugabyte)
 *    - PGDATABASE: Database name (default: ysql_sequelize)
 * 
 * 2. Custom multi-host variable (for load balancing):
 *    - PGHOSTS: Comma-separated list of host:port (e.g., "127.0.0.1:5436,127.0.0.2:5436")
 *               Note: This is a custom variable, not standard PostgreSQL. Takes precedence over PGHOST.
 * 
 * 3. YugabyteDB load balancing variables (extensions to standard PostgreSQL):
 *    - PGLOADBALANCE: Read load balancing mode (any, only-primary, prefer-primary, prefer-rr, only-rr)
 *    - PGWRITELOADBALANCE: Write load balancing mode (default: only-primary)
 *    - PGTOPOLOGYKEYS: Optional topology awareness keys
 *    - PGFALLBACKTOTOPOLOGYKEYSONLY: Optional fallback to topology keys only (default: false)
 *    - PGYBSERVERSREFRESHINTERVAL: Optional metadata refresh interval in seconds (default: 5)
 *    - PGFAILEDHOSTRECONNECTDELAYSECS: Optional reconnect delay in seconds (default: 5)
 */

const fs = require('fs');
const path = require('path');
const sequelizePkg = require('sequelize-yugabytedb');

const { Sequelize } = sequelizePkg;

const basename = path.basename(__filename);
const env = process.env.NODE_ENV || 'development';
const baseConfig = require(path.join(__dirname, '..', 'config', 'config.json'))[
  env
];

const db = {};

const DEFAULT_YB_PORT = 5436;

const normalizeBooleanEnv = value =>
  typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value);

const parseHosts = rawHosts =>
  rawHosts
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [host, rawPort] = entry.split(':');
      return {
        host,
        port: Number(rawPort) || DEFAULT_YB_PORT,
      };
    });

const HOSTS = (() => {
  // Check for PGHOSTS first (comma-separated list), then PGHOST (single host)
  if (process.env.PGHOSTS) {
    return parseHosts(process.env.PGHOSTS);
  }
  
  if (process.env.PGHOST) {
    const port = process.env.PGPORT || DEFAULT_YB_PORT;
    return parseHosts(`${process.env.PGHOST}:${port}`);
  }

  if (baseConfig.host) {
    // Allow config.json to specify a single host or host:port entry.
    const hostSpec =
      baseConfig.port && !String(baseConfig.host).includes(':')
        ? `${baseConfig.host}:${baseConfig.port}`
        : baseConfig.host;
    return parseHosts(hostSpec);
  }

  // Default to the local 3-node setup (127.0.0.[1-3]:5436) provisioned in docs.
  return parseHosts('127.0.0.1:5436,127.0.0.2:5436,127.0.0.3:5436');
})();

// Load balance mode options: 
// - 'any': Uses all nodes, least-loaded selection works immediately (best for reliability)
// - 'prefer-rr': Tries read replicas first, falls back to primary if RR unavailable
// - 'only-rr': Only uses read replicas (requires metadata refresh, may fail on first connection)
// - 'only-primary': Only uses primary nodes (for writes)
// - 'prefer-primary': Prefers primary, falls back to RR
const READ_LOAD_BALANCE_MODE = process.env.PGLOADBALANCE || "any";
const WRITE_LOAD_BALANCE_MODE = process.env.PGWRITELOADBALANCE || "only-primary";

// Optional topology awareness and driver tuning (only set if needed)
const TOPOLOGY_KEYS = process.env.PGTOPOLOGYKEYS || "";
const FALLBACK_TO_TOPOLOGY_KEYS_ONLY = normalizeBooleanEnv(process.env.PGFALLBACKTOTOPOLOGYKEYSONLY) || false;
const SERVER_REFRESH_INTERVAL = process.env.PGYBSERVERSREFRESHINTERVAL ? Number(process.env.PGYBSERVERSREFRESHINTERVAL) : 5;
const FAILED_HOST_RECONNECT_DELAY_SECS = process.env.PGFAILEDHOSTRECONNECTDELAYSECS ? Number(process.env.PGFAILEDHOSTRECONNECTDELAYSECS) : 5;

const SMART_DRIVER_DEFAULTS = {
  ...(TOPOLOGY_KEYS ? { topologyKeys: TOPOLOGY_KEYS } : {}),
  ...(FALLBACK_TO_TOPOLOGY_KEYS_ONLY
    ? { fallbackToTopologyKeysOnly: true }
    : {}),
  ...(Number.isFinite(SERVER_REFRESH_INTERVAL)
    ? { ybServersRefreshInterval: SERVER_REFRESH_INTERVAL }
    : {}),
  ...(Number.isFinite(FAILED_HOST_RECONNECT_DELAY_SECS)
    ? { failedHostReconnectDelaySecs: FAILED_HOST_RECONNECT_DELAY_SECS }
    : {}),
};

function createSmartSequelizeInstance() {
  const [primaryHost] = HOSTS;

  const username = process.env.PGUSER || baseConfig.username || 'yugabyte';
  const password = process.env.PGPASSWORD || (baseConfig.password && baseConfig.password !== '' ? baseConfig.password : 'yugabyte');
  const database = process.env.PGDATABASE || baseConfig.database || 'ysql_sequelize';

  const logLevel = (process.env.LOG_LEVEL || '').toLowerCase();
  
  const loggingType =
    logLevel === 'silly'
      ? console.log
      : false;

  // Use all hosts for read replicas (load balancing will handle node selection)
  const readReplicas = HOSTS;

  const buildConnectionConfig = ({ host, port }, loadBalanceValue) => ({
    host,
    port,
    username,
    password,
    database,
    loadBalance: loadBalanceValue,
    ...SMART_DRIVER_DEFAULTS,
  });

  return new Sequelize({
    dialect: 'postgres',
    database,
    username,
    password,
    logging: loggingType,
    replication: {
      write: buildConnectionConfig(primaryHost, WRITE_LOAD_BALANCE_MODE),
      read: readReplicas.map(node =>
        buildConnectionConfig(node, READ_LOAD_BALANCE_MODE),
      ),
    },
    pool: {
      max: 10,
      min: 2,
      idle: 10000,
      acquire: 30000,
    },
    dialectOptions: {
      statement_timeout: 60000,
    },
  });
}

/**
 * Alternative: Using Connection String
 * 
 * This creates a simpler single-connection instance using a PostgreSQL connection URL.
 * Load balancing parameters are passed as query parameters in the URL.
 */
function createSequelizeWithConnectionString() {
  const username = process.env.PGUSER || baseConfig.username || 'yugabyte';
  const password = process.env.PGPASSWORD || (baseConfig.password && baseConfig.password !== '' ? baseConfig.password : 'yugabyte');
  const database = process.env.PGDATABASE || baseConfig.database || 'ysql_sequelize';
  
  // Use first host for simple connection
  const { host, port } = HOSTS[0];
  
  // Build connection string with load balance parameters
  const connectionString = 
    `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}` +
    `?loadBalance=${READ_LOAD_BALANCE_MODE}` +
    (TOPOLOGY_KEYS ? `&topologyKeys=${encodeURIComponent(TOPOLOGY_KEYS)}` : '') +
    `&ybServersRefreshInterval=${SERVER_REFRESH_INTERVAL}` +
    `&failedHostReconnectDelaySecs=${FAILED_HOST_RECONNECT_DELAY_SECS}` +
    (FALLBACK_TO_TOPOLOGY_KEYS_ONLY ? `&fallbackToTopologyKeysOnly=true` : '');
  
  const logLevel = (process.env.LOG_LEVEL || '').toLowerCase();
  const loggingType = logLevel === 'silly' ? console.log : false;
  
  console.log(`Connection string (sanitized): postgres://${username}:****@${host}:${port}/${database}?loadBalance=${READ_LOAD_BALANCE_MODE}...`);
  
  return new Sequelize(connectionString, {
    dialect: 'postgres',
    logging: loggingType,
    pool: {
      max: 10,
      min: 2,
      idle: 10000,
      acquire: 30000,
    },
    dialectOptions: {
      statement_timeout: 60000,
    },
  });
}

// Choose which method to use:
const sequelize = createSmartSequelizeInstance();
// Uncomment to use connection string instead:
// const sequelize = createSequelizeWithConnectionString();

fs
  .readdirSync(__dirname)
  .filter(file => {
    return (
      file.indexOf('.') !== 0 &&
      file !== basename &&
      file.slice(-3) === '.js'
    );
  })
  .forEach(file => {
    // const model = sequelize['import'](path.join(__dirname, file));
    // REASON for not using above line of code: sequelize.import has been
    // deprecated. See: https://github.com/sequelize/sequelize/pull/12175
    const model = require(path.join(__dirname, file))(
      sequelize,
      sequelizePkg.DataTypes,
    );
    db[model.name] = model;
  });

Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
