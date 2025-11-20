require('dotenv').config();

'use strict';

/**
 * Smart‑driver aware Sequelize bootstrap for YugabyteDB.
 *
 * Load balancing configuration via environment variables:
 * - YB_HOSTS: Comma-separated list of host:port (e.g., "127.0.0.1:5436,127.0.0.2:5436")
 * - YB_LOAD_BALANCE: Read load balancing mode (any, only-primary, prefer-primary, prefer-rr, only-rr)
 * - YB_WRITE_LOAD_BALANCE: Write load balancing mode (default: only-primary)
 * - YB_TOPOLOGY_KEYS: Optional topology awareness keys
 * - YB_SERVERS_REFRESH_INTERVAL: Optional metadata refresh interval (default: 5s)
 * - YB_FAILED_HOST_RECONNECT_DELAY_SECS: Optional reconnect delay (default: 5s)
 *
 * These are bridged to @yugabytedb/pg driver via PG* environment variables.
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
  if (process.env.YB_HOSTS) {
    return parseHosts(process.env.YB_HOSTS);
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
const READ_LOAD_BALANCE_MODE = "any";
const WRITE_LOAD_BALANCE_MODE = "only-primary";

// Optional topology awareness and driver tuning (only set if needed)
const TOPOLOGY_KEYS = "";
const FALLBACK_TO_TOPOLOGY_KEYS_ONLY = false;
const SERVER_REFRESH_INTERVAL = 5;
const FAILED_HOST_RECONNECT_DELAY_SECS = 5;

const ensureEnv = (key, value) => {
  if (
    typeof value !== 'undefined' &&
    value !== null &&
    value !== '' &&
    !process.env[key]
  ) {
    process.env[key] = String(value);
  }
};


// These environment varibales are passed to the @yugabytedb/pg driver.
ensureEnv('PGLOADBALANCE', READ_LOAD_BALANCE_MODE);
ensureEnv('PGTOPOLOGYKEYS', TOPOLOGY_KEYS);
ensureEnv(
  'PGFALLBACKTOTOPOLOGYKEYSONLY', 
  FALLBACK_TO_TOPOLOGY_KEYS_ONLY ? 'true' : undefined,
);
ensureEnv('PGYBSERVERSREFRESHINTERVAL', SERVER_REFRESH_INTERVAL);
ensureEnv(
  'PGFAILEDHOSTRECONNECTDELAYSECS',
  FAILED_HOST_RECONNECT_DELAY_SECS,
);

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

  const username = baseConfig.username || 'yugabyte';
  const password = baseConfig.password || 'yugabyte';
  const database = baseConfig.database || 'ysql_sequelize';

  const logLevel = (process.env.LOG_LEVEL || '').toLowerCase();
  
  
  // I'll remove this afterwards.
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

const sequelize = createSmartSequelizeInstance();

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
