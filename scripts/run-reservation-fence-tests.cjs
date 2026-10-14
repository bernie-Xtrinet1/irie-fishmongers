/**
 * IRIE FISHMONGERS — Windows Native Disposable Test Infrastructure Launcher
 *
 * Spawns a dedicated launcher-owned Redis process on 127.0.0.1:16479 and creates
 * a disposable PostgreSQL database named g1_isolated_<digits>.
 * Enforces strict ownership, validates all configuration parameters, runs tests
 * serially, and guarantees fail-closed cleanup.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync, execSync } = require('child_process');
const Redis = require('ioredis');

const DEFAULT_REDIS_BIN =
  'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\\Redis-8.8.0-Windows-x64-msys2\\redis-server.exe';
const DEFAULT_PSQL_BIN = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';

const REQUIRED_REDIS_PORT = 16479;
const REQUIRED_REDIS_HOST = '127.0.0.1';
const REQUIRED_REDIS_DB = 11;
const FORBIDDEN_REDIS_PORT = 6379;
const ISOLATED_DB_REGEX = /^g1_isolated_[0-9]+$/;
const PROTECTED_DATABASES = new Set(['postgres', 'template0', 'template1', 'iriefishmongers_dev', 'iriefishmongers']);

function checkNodeVersion() {
  const current = process.versions.node;
  const isTarget = current === '20.18.1';
  return { current, isTarget, warning: isTarget ? null : `Node version mismatch: running ${current}, target is 20.18.1` };
}

function parsePostgresConfig(explicitUrl) {
  let rawUrl = explicitUrl || process.env.DATABASE_URL;
  if (!rawUrl) {
    const envPath = path.resolve(__dirname, '../backend/.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^\s*DATABASE_URL\s*=\s*([^\r\n]+)/m);
      if (match) {
        rawUrl = match[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (!rawUrl) {
    throw new Error('POSTGRES_CONFIG_MISSING: DATABASE_URL not found in environment or backend/.env');
  }

  const parsed = new URL(rawUrl);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(`UNSAFE_POSTGRES_HOST: host must be localhost or 127.0.0.1, got ${parsed.hostname}`);
  }

  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '5432', 10),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    maintenanceDb: 'postgres',
    rawUrl,
  };
}

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function getListeningPid(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0].toUpperCase() === 'TCP') {
        const localAddr = parts[1];
        const state = parts[3];
        const pid = parseInt(parts[parts.length - 1], 10);
        if (state === 'LISTENING' && localAddr.endsWith(`:${port}`)) {
          return pid;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function startDisposableRedis(options = {}) {
  const port = options.port || REQUIRED_REDIS_PORT;
  const host = options.host || REQUIRED_REDIS_HOST;
  const redisBin = options.redisBin || DEFAULT_REDIS_BIN;

  if (port === FORBIDDEN_REDIS_PORT) {
    throw new Error(`FORBIDDEN_PORT: Never touch normal Redis port ${FORBIDDEN_REDIS_PORT}`);
  }
  if (port !== REQUIRED_REDIS_PORT) {
    throw new Error(`INVALID_PORT: Redis port must be exactly ${REQUIRED_REDIS_PORT}, got ${port}`);
  }

  const free = await isPortAvailable(port, host);
  if (!free) {
    const existingPid = getListeningPid(port);
    throw new Error(`REDIS_PORT_OCCUPIED: Port ${port} is already in use (PID: ${existingPid || 'unknown'}). Refusing to adopt.`);
  }

  if (!fs.existsSync(redisBin)) {
    throw new Error(`REDIS_BINARY_NOT_FOUND: Cannot find redis-server at ${redisBin}`);
  }

  const args = [
    '--bind', host,
    '--port', String(port),
    '--save', '',
    '--appendonly', 'no',
    '--daemonize', 'no',
    '--databases', '16',
  ];

  const child = spawn(redisBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const spawnPid = child.pid;

  let exitError = null;
  child.once('exit', (code, signal) => {
    exitError = new Error(`REDIS_PROCESS_EXITED_EARLY: code ${code}, signal ${signal}`);
  });

  const deadline = Date.now() + 7000;
  let ready = false;
  while (Date.now() < deadline) {
    if (exitError) throw exitError;
    const canConnect = await new Promise((res) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        res(true);
      });
      socket.once('error', () => res(false));
    });
    if (canConnect) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!ready) {
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`REDIS_STARTUP_TIMEOUT: Redis did not become ready within 7000ms`);
  }

  const actualPid = getListeningPid(port);
  if (actualPid && actualPid !== spawnPid) {
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`REDIS_PID_MISMATCH: Spawned PID ${spawnPid} does not match listener PID ${actualPid}`);
  }

  const client = new Redis({
    host,
    port,
    db: REQUIRED_REDIS_DB,
    lazyConnect: true,
    retryStrategy: null,
    maxRetriesPerRequest: 1,
  });

  try {
    await client.connect();

    const [bindKey, bindVal] = await client.config('GET', 'bind');
    if (bindVal !== host) throw new Error(`REDIS_CONFIG_MISMATCH: bind expected ${host}, got ${bindVal}`);

    const [portKey, portVal] = await client.config('GET', 'port');
    if (portVal !== String(port)) throw new Error(`REDIS_CONFIG_MISMATCH: port expected ${port}, got ${portVal}`);

    const [saveKey, saveVal] = await client.config('GET', 'save');
    if (saveVal !== '') throw new Error(`REDIS_CONFIG_MISMATCH: save expected empty, got ${saveVal}`);

    const [aofKey, aofVal] = await client.config('GET', 'appendonly');
    if (aofVal !== 'no') throw new Error(`REDIS_CONFIG_MISMATCH: appendonly expected 'no', got ${aofVal}`);

    const [daemonKey, daemonVal] = await client.config('GET', 'daemonize');
    if (daemonVal !== 'no') throw new Error(`REDIS_CONFIG_MISMATCH: daemonize expected 'no', got ${daemonVal}`);

    const serverInfo = await client.info('server');
    if (!serverInfo.includes('redis_mode:standalone')) {
      throw new Error('REDIS_MODE_MISMATCH: server is not in standalone mode');
    }

    const clusterInfo = await client.info('cluster');
    if (!clusterInfo.includes('cluster_enabled:0')) {
      throw new Error('REDIS_CLUSTER_ENABLED: server must have cluster disabled');
    }

    await client.select(REQUIRED_REDIS_DB);
  } catch (err) {
    try { client.disconnect(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    throw err;
  }

  const state = {
    child,
    pid: spawnPid,
    port,
    host,
    db: REQUIRED_REDIS_DB,
    client,
    url: `redis://${host}:${port}/${REQUIRED_REDIS_DB}`,
    owned: true,
  };

  return state;
}

async function stopDisposableRedis(redisState) {
  if (!redisState || !redisState.owned) {
    throw new Error('REDIS_CLEANUP_UNCERTAIN: Cannot stop unowned or null Redis state');
  }

  try {
    if (redisState.client) {
      if (redisState.client.status === 'ready') await redisState.client.quit();
      else redisState.client.disconnect();
    }
  } catch {}

  const pid = redisState.pid;
  try {
    if (redisState.child && !redisState.child.killed) {
      redisState.child.kill('SIGTERM');
    }
  } catch {}

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const activePid = getListeningPid(redisState.port);
    if (!activePid || activePid !== pid) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const remainingPid = getListeningPid(redisState.port);
  if (remainingPid && remainingPid === pid) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } catch {}
  }

  const isFree = await isPortAvailable(redisState.port, redisState.host);
  if (!isFree) {
    throw new Error(`REDIS_CLEANUP_FAILED: Port ${redisState.port} still in use after termination attempt`);
  }
}

function execPsql(pgConfig, dbName, sql, psqlBin = DEFAULT_PSQL_BIN) {
  if (!fs.existsSync(psqlBin)) {
    throw new Error(`PSQL_NOT_FOUND: psql executable not found at ${psqlBin}`);
  }

  const env = { ...process.env, PGPASSWORD: pgConfig.password };
  const args = [
    '-h', pgConfig.host,
    '-p', String(pgConfig.port),
    '-U', pgConfig.user,
    '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-A', '-t',
    '-c', sql,
  ];

  try {
    const res = execFileSync(psqlBin, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return res.trim();
  } catch (err) {
    const sanitized = err.message ? err.message.replace(new RegExp(pgConfig.password, 'g'), '******') : 'Unknown error';
    throw new Error(`PSQL_EXEC_FAILED: ${sanitized}`);
  }
}

function createIsolatedPostgres(pgConfig, options = {}) {
  const psqlBin = options.psqlBin || DEFAULT_PSQL_BIN;
  const digits = `${Date.now()}${process.pid}${Math.floor(Math.random() * 1000)}`;
  const dbName = `g1_isolated_${digits}`;

  if (!ISOLATED_DB_REGEX.test(dbName)) {
    throw new Error(`DATABASE_NAME_INVALID: Name ${dbName} does not match required pattern ${ISOLATED_DB_REGEX}`);
  }
  if (PROTECTED_DATABASES.has(dbName)) {
    throw new Error(`DATABASE_NAME_PROTECTED: Name ${dbName} is a protected database`);
  }

  const exists = execPsql(pgConfig, pgConfig.maintenanceDb, `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`, psqlBin);
  if (exists === '1') {
    throw new Error(`DATABASE_ALREADY_EXISTS: ${dbName} already exists. Refusing.`);
  }

  execPsql(pgConfig, pgConfig.maintenanceDb, `CREATE DATABASE "${dbName}" WITH ENCODING 'UTF8' TEMPLATE template0;`, psqlBin);

  const confirmed = execPsql(pgConfig, pgConfig.maintenanceDb, `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`, psqlBin);
  if (confirmed !== '1') {
    throw new Error(`DATABASE_CREATION_VERIFICATION_FAILED: Could not verify ${dbName} exists`);
  }

  const encodedUser = encodeURIComponent(pgConfig.user);
  const encodedPass = encodeURIComponent(pgConfig.password);
  const targetUrl = `postgresql://${encodedUser}:${encodedPass}@${pgConfig.host}:${pgConfig.port}/${dbName}`;

  return {
    dbName,
    targetUrl,
    createdByLauncher: true,
    ownerPid: process.pid,
    createdAt: Date.now(),
  };
}

function dropIsolatedPostgres(pgConfig, dbRecord, options = {}) {
  if (!dbRecord || !dbRecord.createdByLauncher || dbRecord.ownerPid !== process.pid) {
    throw new Error(`DATABASE_OWNERSHIP_UNCERTAIN: Database record not created by current process. Refusing drop.`);
  }

  const dbName = dbRecord.dbName;
  if (!ISOLATED_DB_REGEX.test(dbName)) {
    throw new Error(`DATABASE_NAME_UNSAFE: Refusing to drop database ${dbName} not matching ${ISOLATED_DB_REGEX}`);
  }
  if (PROTECTED_DATABASES.has(dbName)) {
    throw new Error(`DATABASE_PROTECTED: Cannot drop protected database ${dbName}`);
  }

  const psqlBin = options.psqlBin || DEFAULT_PSQL_BIN;

  try {
    execPsql(
      pgConfig,
      pgConfig.maintenanceDb,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      psqlBin
    );
  } catch (_termErr) {
    // Non-superuser role in Windows PG16 may not terminate foreign processes;
    // DROP DATABASE WITH (FORCE) terminates active connections.
  }

  execPsql(pgConfig, pgConfig.maintenanceDb, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`, psqlBin);

  const remains = execPsql(pgConfig, pgConfig.maintenanceDb, `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`, psqlBin);
  if (remains === '1') {
    throw new Error(`DATABASE_DROP_VERIFICATION_FAILED: Database ${dbName} still exists after DROP attempt`);
  }
}

function migrateIsolatedPostgres(dbRecord, options = {}) {
  if (!dbRecord || !dbRecord.createdByLauncher || dbRecord.ownerPid !== process.pid) {
    throw new Error('DATABASE_OWNERSHIP_UNCERTAIN: Refusing to migrate unowned database');
  }

  const dbName = dbRecord.dbName;
  if (!ISOLATED_DB_REGEX.test(dbName)) {
    throw new Error(`DATABASE_NAME_UNSAFE: Refusing to migrate database ${dbName} not matching ${ISOLATED_DB_REGEX}`);
  }
  if (PROTECTED_DATABASES.has(dbName)) {
    throw new Error(`DATABASE_PROTECTED: Cannot migrate protected database ${dbName}`);
  }

  const prismaCli = options.prismaCli || path.resolve(__dirname, '../backend/node_modules/prisma/build/index.js');
  const schemaPath = options.schemaPath || path.resolve(__dirname, '../backend/prisma/schema.prisma');

  console.log(`[LAUNCHER] Deploying migrations to ${dbRecord.dbName}...`);
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: dbRecord.targetUrl },
    stdio: options.silentMigrations ? 'pipe' : 'inherit',
    timeout: 120000,
  });
  console.log(`[LAUNCHER] Migrations deployed successfully to ${dbRecord.dbName}.`);
}

function buildChildEnv(dbRecord, redisState) {
  const baseEnv = { ...process.env };
  // Purge any inherited external-service credentials or endpoint configurations
  for (const key of Object.keys(baseEnv)) {
    if (
      key.startsWith('WIPAY_') ||
      key.startsWith('FIREBASE_') ||
      key.startsWith('SENDGRID_') ||
      key.startsWith('STRIPE_') ||
      key.startsWith('AWS_') ||
      key.startsWith('GOOGLE_MAPS_') ||
      key.startsWith('SENTRY_')
    ) {
      delete baseEnv[key];
    }
  }

  return {
    ...baseEnv,
    DATABASE_URL: dbRecord.targetUrl,
    REDIS_URL: redisState.url,
    NODE_ENV: 'test',
    ENABLE_SCHEDULER: 'false',
    EMAIL_ENABLED: 'false',
    SENDGRID_API_KEY: 'test-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'test@example.com',
    PORT: '3001',
    API_PREFIX: 'api/v1',
    APP_BASE_URL: 'http://127.0.0.1:3001',
    CORS_ORIGIN: 'http://127.0.0.1:3000',
    JWT_ACCESS_SECRET: '01234567890123456789012345678901',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: '01234567890123456789012345678901',
    JWT_REFRESH_EXPIRES_IN: '7d',
    WIPAY_API_URL: 'http://127.0.0.1:3001/mock-wipay',
    WIPAY_ENVIRONMENT: 'sandbox',
    WIPAY_FEE_STRUCTURE: 'merchant_absorb',
    WIPAY_ACCOUNT_NUMBER: 'test-wipay-account',
    WIPAY_API_KEY: 'test-wipay-key',
    FIREBASE_PROJECT_ID: 'test-firebase-project',
    FIREBASE_CLIENT_EMAIL: 'test-service-account@test-firebase-project.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'test-firebase-private-key',
  };
}

async function runLauncher(testPatterns = [], options = {}) {
  const nodeInfo = checkNodeVersion();
  if (nodeInfo.warning) {
    console.warn(`[LAUNCHER] ${nodeInfo.warning}`);
  }

  const pgConfig = parsePostgresConfig(options.databaseUrl);
  console.log(`[LAUNCHER] Verified PostgreSQL configuration for host ${pgConfig.host}:${pgConfig.port}`);

  console.log(`[LAUNCHER] Starting disposable Redis on ${REQUIRED_REDIS_HOST}:${REQUIRED_REDIS_PORT}...`);
  const redisState = await startDisposableRedis(options);
  console.log(`[LAUNCHER] Disposable Redis verified and ready at ${redisState.url} (PID: ${redisState.pid})`);

  let dbRecord = null;
  let testExitCode = 1;

  try {
    console.log(`[LAUNCHER] Creating isolated PostgreSQL database...`);
    dbRecord = createIsolatedPostgres(pgConfig, options);
    console.log(`[LAUNCHER] Created database ${dbRecord.dbName} (ownership verified)`);

    if (!options.skipMigrations) {
      migrateIsolatedPostgres(dbRecord, options);
    }

    const childEnv = buildChildEnv(dbRecord, redisState);

    let testChild;
    if (options.customCommand) {
      console.log(`[LAUNCHER] Executing custom command: ${options.customCommand} ${(options.customArgs || []).join(' ')}`);
      testChild = spawn(options.customCommand, options.customArgs || [], {
        env: childEnv,
        stdio: 'inherit',
        shell: options.shell !== undefined ? options.shell : false,
      });
    } else {
      const patterns = testPatterns && testPatterns.length > 0 ? testPatterns : ['reservation-fence'];
      const jestArgs = ['run', 'test', '-w', 'backend', '--', '--runInBand', ...patterns];
      console.log(`[LAUNCHER] Executing tests: npm.cmd ${jestArgs.join(' ')}`);
      testChild = spawn('npm.cmd', jestArgs, {
        env: childEnv,
        stdio: 'inherit',
        shell: true,
      });
    }

    testExitCode = await new Promise((resolve) => {
      testChild.on('close', (code) => resolve(code ?? 1));
      testChild.on('error', (err) => {
        console.error('[LAUNCHER] Test execution process error:', err);
        resolve(1);
      });
    });

    console.log(`[LAUNCHER] Tests finished with exit code ${testExitCode}`);
  } finally {
    if (dbRecord) {
      try {
        console.log(`[LAUNCHER] Cleaning up isolated database ${dbRecord.dbName}...`);
        dropIsolatedPostgres(pgConfig, dbRecord, options);
        console.log(`[LAUNCHER] Database cleanup verified.`);
      } catch (dropErr) {
        console.error(`[LAUNCHER_ERROR] Cleanup failed for ${dbRecord.dbName}:`, dropErr);
      }
    }

    try {
      console.log(`[LAUNCHER] Stopping disposable Redis...`);
      await stopDisposableRedis(redisState);
      console.log(`[LAUNCHER] Redis stopped and port verified free.`);
    } catch (redisErr) {
      console.error(`[LAUNCHER_ERROR] Redis cleanup failed:`, redisErr);
    }
  }

  return testExitCode;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  runLauncher(args)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error('[LAUNCHER_FATAL]', err);
      process.exit(1);
    });
}

module.exports = {
  REQUIRED_REDIS_PORT,
  REQUIRED_REDIS_HOST,
  REQUIRED_REDIS_DB,
  FORBIDDEN_REDIS_PORT,
  ISOLATED_DB_REGEX,
  PROTECTED_DATABASES,
  DEFAULT_REDIS_BIN,
  DEFAULT_PSQL_BIN,
  checkNodeVersion,
  parsePostgresConfig,
  isPortAvailable,
  getListeningPid,
  startDisposableRedis,
  stopDisposableRedis,
  execPsql,
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  dropIsolatedPostgres,
  buildChildEnv,
  runLauncher,
};
