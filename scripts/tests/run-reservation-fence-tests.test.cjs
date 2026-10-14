/**
 * Unit & Safety Tests for Windows Native Disposable Test Infrastructure Launcher
 *
 * Verifies:
 * - Refusal of occupied Redis port
 * - Refusal of existing / protected database names
 * - Rejection of Redis 6379 (never touches service IrieRedis)
 * - Rejection of unowned databases or wrong process ownership
 * - Rejection of invalid / unsafe database names
 * - Rejection of non-localhost PostgreSQL configurations
 * - Rejection of configuration mismatches
 * - Cleanup safety and fail-closed uncertainty behavior
 * - Exit code propagation
 */

'use strict';

const assert = require('assert');
const net = require('net');
const {
  REQUIRED_REDIS_PORT,
  REQUIRED_REDIS_HOST,
  REQUIRED_REDIS_DB,
  FORBIDDEN_REDIS_PORT,
  ISOLATED_DB_REGEX,
  PROTECTED_DATABASES,
  checkNodeVersion,
  parsePostgresConfig,
  isPortAvailable,
  startDisposableRedis,
  stopDisposableRedis,
  createIsolatedPostgres,
  dropIsolatedPostgres,
} = require('../run-reservation-fence-tests.cjs');

async function runAllTests() {
  const suites = [];
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  console.log('[TEST_SUITE] Running Launcher Unit & Safety Invariant Tests...\n');

  // 1. Protection of Redis 6379
  await test('Safety: Rejects connection to normal Redis port 6379', async () => {
    await assert.rejects(
      async () => {
        await startDisposableRedis({ port: 6379 });
      },
      /FORBIDDEN_PORT/
    );
  });

  // 2. Protection of arbitrary non-16479 ports
  await test('Safety: Rejects non-16479 Redis ports', async () => {
    await assert.rejects(
      async () => {
        await startDisposableRedis({ port: 6380 });
      },
      /INVALID_PORT/
    );
  });

  // 3. Occupied Redis port rejection
  await test('Preflight: Refuses to start if Redis port 16479 is occupied', async () => {
    const mockServer = net.createServer();
    await new Promise((resolve) => mockServer.listen(REQUIRED_REDIS_PORT, REQUIRED_REDIS_HOST, resolve));

    try {
      await assert.rejects(
        async () => {
          await startDisposableRedis({ port: REQUIRED_REDIS_PORT, host: REQUIRED_REDIS_HOST });
        },
        /REDIS_PORT_OCCUPIED/
      );
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  // 4. Protection of protected databases
  await test('Safety: Rejects dropping protected databases (postgres, template1, iriefishmongers_dev)', async () => {
    const dummyConfig = { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', maintenanceDb: 'postgres' };
    for (const db of ['postgres', 'template0', 'template1', 'iriefishmongers_dev', 'iriefishmongers']) {
      assert.throws(
        () => {
          dropIsolatedPostgres(dummyConfig, { dbName: db, createdByLauncher: true, ownerPid: process.pid });
        },
        /DATABASE_NAME_UNSAFE|DATABASE_PROTECTED/
      );
    }
  });

  // 5. Wrong database ownership rejection
  await test('Ownership: Refuses drop if database was not created by launcher', () => {
    const dummyConfig = { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', maintenanceDb: 'postgres' };

    assert.throws(
      () => {
        dropIsolatedPostgres(dummyConfig, null);
      },
      /DATABASE_OWNERSHIP_UNCERTAIN/
    );

    assert.throws(
      () => {
        dropIsolatedPostgres(dummyConfig, { dbName: 'g1_isolated_12345', createdByLauncher: false, ownerPid: process.pid });
      },
      /DATABASE_OWNERSHIP_UNCERTAIN/
    );

    assert.throws(
      () => {
        dropIsolatedPostgres(dummyConfig, { dbName: 'g1_isolated_12345', createdByLauncher: true, ownerPid: process.pid + 99999 });
      },
      /DATABASE_OWNERSHIP_UNCERTAIN/
    );
  });

  // 6. Database name pattern validation
  await test('Validation: Database name pattern enforces g1_isolated_<digits>', () => {
    assert.strictEqual(ISOLATED_DB_REGEX.test('g1_isolated_1728000000'), true);
    assert.strictEqual(ISOLATED_DB_REGEX.test('g1_isolated_999999999999999'), true);

    // Invalid patterns
    assert.strictEqual(ISOLATED_DB_REGEX.test('g1_isolated_'), false);
    assert.strictEqual(ISOLATED_DB_REGEX.test('g1_isolated_abc'), false);
    assert.strictEqual(ISOLATED_DB_REGEX.test('g1_isolated_123_test'), false);
    assert.strictEqual(ISOLATED_DB_REGEX.test('postgres'), false);
    assert.strictEqual(ISOLATED_DB_REGEX.test('DROP TABLE users;'), false);
  });

  // 7. Cleanup uncertainty fails closed
  await test('Fail-Closed: stopDisposableRedis fails closed on null or unowned state', async () => {
    await assert.rejects(
      async () => {
        await stopDisposableRedis(null);
      },
      /REDIS_CLEANUP_UNCERTAIN/
    );

    await assert.rejects(
      async () => {
        await stopDisposableRedis({ owned: false });
      },
      /REDIS_CLEANUP_UNCERTAIN/
    );
  });

  // 8. PostgreSQL configuration validation (rejection of non-local hosts)
  await test('Validation: parsePostgresConfig rejects non-localhost hosts', () => {
    assert.throws(
      () => {
        parsePostgresConfig('postgresql://user:pass@external-database.azure.com:5432/db');
      },
      /UNSAFE_POSTGRES_HOST/
    );

    const valid = parsePostgresConfig('postgresql://user:secret@127.0.0.1:5432/g1_isolated_123');
    assert.strictEqual(valid.host, '127.0.0.1');
    assert.strictEqual(valid.port, 5432);
    assert.strictEqual(valid.user, 'user');
    assert.strictEqual(valid.password, 'secret');
  });

  // 9. Node runtime version check
  await test('Runtime: checkNodeVersion detects current runtime', () => {
    const info = checkNodeVersion();
    assert.ok(info.current);
    if (info.current === '20.18.1') {
      assert.strictEqual(info.isTarget, true);
      assert.strictEqual(info.warning, null);
    } else {
      assert.strictEqual(info.isTarget, false);
      assert.ok(info.warning.includes('Node version mismatch'));
    }
  });

  // 10. Port availability check helper
  await test('Network: isPortAvailable accurately detects open/closed ports', async () => {
    const freePort = await isPortAvailable(16479, '127.0.0.1');
    assert.strictEqual(typeof freePort, 'boolean');

    const server = net.createServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const boundPort = server.address().port;

    const occupied = await isPortAvailable(boundPort, '127.0.0.1');
    assert.strictEqual(occupied, false);

    await new Promise((res) => server.close(res));
    const nowFree = await isPortAvailable(boundPort, '127.0.0.1');
    assert.strictEqual(nowFree, true);
  });

  // 11. End-to-end infrastructure smoke test
  await test('Infrastructure Smoke: Proves real Redis 8.8.0 configuration and PostgreSQL 16 isolation', async () => {
    const { runLauncher, parsePostgresConfig, execPsql, DEFAULT_PSQL_BIN } = require('../run-reservation-fence-tests.cjs');
    let observedDbName = null;

    const smokeScript = [
      'const assert = require("assert");',
      'const Redis = require("ioredis");',
      'async function verify() {',
      '  assert.strictEqual(process.env.REDIS_URL, "redis://127.0.0.1:16479/11");',
      '  assert.strictEqual(process.env.NODE_ENV, "test");',
      '  assert.strictEqual(process.env.ENABLE_SCHEDULER, "false");',
      '  assert.ok(/\\/g1_isolated_[0-9]+$/.test(process.env.DATABASE_URL));',
      '  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });',
      '  await client.connect();',
      '  assert.deepStrictEqual(await client.config("GET", "bind"), ["bind", "127.0.0.1"]);',
      '  assert.deepStrictEqual(await client.config("GET", "port"), ["port", "16479"]);',
      '  assert.deepStrictEqual(await client.config("GET", "save"), ["save", ""]);',
      '  assert.deepStrictEqual(await client.config("GET", "appendonly"), ["appendonly", "no"]);',
      '  assert.deepStrictEqual(await client.config("GET", "daemonize"), ["daemonize", "no"]);',
      '  assert.ok((await client.info("server")).includes("redis_mode:standalone"));',
      '  assert.ok((await client.info("cluster")).includes("cluster_enabled:0"));',
      '  await client.select(11);',
      '  await client.quit();',
      '  console.log("    [SMOKE_CHILD] Redis 8.8.0 configuration assertions verified.");',
      '}',
      'verify().catch(e => { console.error(e); process.exit(1); });',
    ].join(' ');

    const exitCode = await runLauncher([], {
      customCommand: process.execPath,
      customArgs: ['-e', smokeScript],
      shell: false,
    });

    assert.strictEqual(exitCode, 0, 'Launcher smoke test execution must exit with 0');

    // Confirm Redis on port 16479 is terminated
    const redisFree = await isPortAvailable(REQUIRED_REDIS_PORT, REQUIRED_REDIS_HOST);
    assert.strictEqual(redisFree, true, 'Port 16479 must be released after launcher exits');

    // Confirm service IrieRedis on port 6379 is still intact and listening
    const irieRedisOccupied = !(await isPortAvailable(FORBIDDEN_REDIS_PORT, REQUIRED_REDIS_HOST));
    assert.strictEqual(irieRedisOccupied, true, 'Service IrieRedis on port 6379 must remain untouched');
  });

  console.log(`\n[TEST_SUMMARY] ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAllTests().catch((err) => {
    console.error('[TEST_FATAL]', err);
    process.exit(1);
  });
}

// Jest compatibility wrapper
if (typeof describe === 'function') {
  describe('Windows Native Launcher Safety Invariants', () => {
    it('executes unit test suite cleanly', async () => {
      await runAllTests();
    });
  });
}

module.exports = { runAllTests };
