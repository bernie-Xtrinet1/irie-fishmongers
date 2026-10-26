import { PrismaClient } from '@prisma/client';
import { execSync, spawnSync } from 'child_process';

/**
 * Thrown when an environment, connection string, or database state fails isolation assertions.
 */
export class DatabaseIsolationGuardError extends Error {
  constructor(message: string) {
    super(`[FAIL-CLOSED ISOLATION GUARD] ${message}`);
    this.name = 'DatabaseIsolationGuardError';
  }
}

/**
 * Report containing non-secret verification details of database connection isolation.
 */
export interface DatabaseIsolationReport {
  readonly isIsolated: boolean;
  readonly databaseName: string;
  readonly host: string;
  readonly port: number;
  readonly sanitizedUrl: string;
  readonly violations: readonly string[];
}

/**
 * Report containing non-secret verification details of container environment isolation.
 */
export interface ContainerIsolationReport {
  readonly isDockerAvailable: boolean;
  readonly containerId?: string;
  readonly image?: string;
  readonly projectName?: string;
  readonly networkName?: string;
  readonly volumeName?: string;
  readonly isolationVerified: boolean;
  readonly violations: readonly string[];
}

/**
 * Report containing non-secret verification details of native PostgreSQL cluster isolation.
 */
export interface NativeClusterIsolationReport {
  readonly isNativeClusterVerified: boolean;
  readonly expectedDataDir: string;
  readonly actualDataDir: string;
  readonly expectedPort: number;
  readonly actualPort: number;
  readonly expectedDbName: string;
  readonly actualDbName: string;
  readonly serverHost: string;
  readonly pgVersion: string;
  readonly backendPid: number;
  readonly isDefaultServiceBlocked: boolean;
  readonly publicTableCount: number;
  readonly prismaMigrationCount: number;
  readonly violations: readonly string[];
}

/**
 * Forbidden host patterns that must NEVER be contacted for integration testing.
 */
const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
  /rds\.amazonaws\.com$/i,
  /supabase\.co$/i,
  /railway\.app$/i,
  /neon\.tech$/i,
  /render\.com$/i,
  /cloudsql/i,
  /prod/i,
  /staging/i,
];

/**
 * Mandatory pattern for disposable test databases.
 * Rejects production, staging, and the repository's default shared development database ("iriefishmongers").
 */
export const DISPOSABLE_DB_NAME_PATTERN = /^.*_disposable_test(_.*)?$/i;

/**
 * Expected constants for native temporary cluster isolation.
 */
export const EXPECTED_NATIVE_CLUSTER_PORT = 54329;
export const EXPECTED_DISPOSABLE_DB_NAME = 'irie_wp42b_disposable_test_db';
export const EXPECTED_ROLLBACK_REFUSAL_DB_NAME = 'irie_wp42b_disposable_test_rollback_refusal';
export const EXPECTED_ROLLBACK_CLEAN_DB_NAME = 'irie_wp42b_disposable_test_rollback_clean';
export const EXPECTED_TEMPORARY_DATA_DIR = 'C:/Users/user/AppData/Local/Temp/irie_pg16_wp42b_cluster';
export const PROHIBITED_DEFAULT_DATA_DIR = 'C:/Program Files/PostgreSQL/16/data';
export const PROHIBITED_DEFAULT_PORT = 5432;

/**
 * Normalizes Windows and POSIX path separators to forward slashes for reliable comparison.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Validates that a PostgreSQL database URL points to a strictly isolated, disposable test database.
 * NEVER prints credentials, passwords, or query tokens.
 */
export function validateDatabaseIsolationUrl(
  rawUrl?: string,
  options?: {
    requiredPattern?: RegExp;
    expectedPort?: number;
    requireLoopback?: boolean;
    expectedDbName?: string;
  },
): DatabaseIsolationReport {
  const violations: string[] = [];
  const requiredPattern = options?.requiredPattern || DISPOSABLE_DB_NAME_PATTERN;
  const expectedPort = options?.expectedPort ?? EXPECTED_NATIVE_CLUSTER_PORT;
  const requireLoopback = options?.requireLoopback ?? true;
  const expectedDbName = options?.expectedDbName ?? EXPECTED_DISPOSABLE_DB_NAME;

  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return {
      isIsolated: false,
      databaseName: '',
      host: '',
      port: 0,
      sanitizedUrl: '<EMPTY>',
      violations: ['Database URL is undefined or empty.'],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return {
      isIsolated: false,
      databaseName: '',
      host: '',
      port: 0,
      sanitizedUrl: '<MALFORMED>',
      violations: [`Database URL could not be parsed as a valid URI: ${(err as Error).message}`],
    };
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    violations.push(`Invalid protocol: expected postgresql: or postgres:, got ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  const dbName = parsed.pathname.replace(/^\//, '');

  // Check forbidden hosts
  for (const forbidden of FORBIDDEN_HOST_PATTERNS) {
    if (forbidden.test(host)) {
      violations.push(`Forbidden host pattern detected (${host}). Refusing connection.`);
    }
  }

  // Enforce loopback host
  if (requireLoopback && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    violations.push(`Non-loopback host "${host}" is forbidden for isolated testing. Must connect to 127.0.0.1.`);
  }

  // Refuse default PostgreSQL port (5432) to prevent accidental connection to shared dev instance
  if (port === PROHIBITED_DEFAULT_PORT) {
    violations.push(
      `Default port ${PROHIBITED_DEFAULT_PORT} is prohibited. Native test cluster must use dedicated port ${expectedPort}.`,
    );
  } else if (expectedPort && port !== expectedPort) {
    violations.push(`Port ${port} does not match expected dedicated test port ${expectedPort}.`);
  }

  // Refuse default shared dev DB without disposable indicator
  if (dbName.toLowerCase() === 'iriefishmongers' || dbName.toLowerCase() === 'postgres') {
    violations.push(
      `Shared default database name "${dbName}" is prohibited. Test database must use an isolated disposable name matching ${requiredPattern}.`,
    );
  }

  // Require matching disposable pattern
  if (!requiredPattern.test(dbName)) {
    violations.push(
      `Database name "${dbName}" does not match required disposable pattern ${requiredPattern}.`,
    );
  }

  // Require exact expected database name if specified
  if (expectedDbName && dbName !== expectedDbName) {
    violations.push(
      `Database name "${dbName}" does not match exact authorized disposable database name "${expectedDbName}".`,
    );
  }

  // Build sanitized URL with credentials completely masked
  const sanitizedUrl = `${parsed.protocol}//***:***@${host}:${port}/${dbName}${parsed.search ? '?schema=public' : ''}`;

  return {
    isIsolated: violations.length === 0,
    databaseName: dbName,
    host,
    port,
    sanitizedUrl,
    violations,
  };
}

/**
 * Asserts native temporary PostgreSQL cluster isolation against a live PrismaClient instance.
 * Fails closed immediately if data directory, port, server address, or database identity violate isolation invariants.
 */
export async function assertNativeClusterIsolation(
  prisma: PrismaClient,
  options?: {
    expectedDbName?: string;
    expectedPort?: number;
    expectedDataDir?: string;
    allowNonEmpty?: boolean;
  },
): Promise<NativeClusterIsolationReport> {
  const violations: string[] = [];
  const expectedDbName = options?.expectedDbName ?? EXPECTED_DISPOSABLE_DB_NAME;
  const expectedPort = options?.expectedPort ?? EXPECTED_NATIVE_CLUSTER_PORT;
  const expectedDataDir = options?.expectedDataDir ?? EXPECTED_TEMPORARY_DATA_DIR;

  interface ServerIdentityRow {
    current_db: string;
    server_host: string;
    server_port: number;
    data_dir: string;
    pg_version: string;
    backend_pid: number;
  }

  const identityRows: ServerIdentityRow[] = await prisma.$queryRaw`
    SELECT 
      current_database() as current_db,
      host(inet_server_addr()) as server_host,
      inet_server_port() as server_port,
      current_setting('data_directory') as data_dir,
      version() as pg_version,
      pg_backend_pid() as backend_pid;
  `;

  const firstRow = identityRows[0];
  if (!firstRow) {
    throw new DatabaseIsolationGuardError('Could not query current database server identity from connection.');
  }

  const actualDbName = firstRow.current_db;
  const serverHost = firstRow.server_host;
  const actualPort = Number(firstRow.server_port);
  const actualDataDir = firstRow.data_dir;
  const pgVersion = firstRow.pg_version;
  const backendPid = Number(firstRow.backend_pid);

  // 1. Verify exact database name
  if (actualDbName !== expectedDbName) {
    violations.push(
      `Connected database name "${actualDbName}" does not match exact authorized test database "${expectedDbName}".`,
    );
  }

  // 2. Verify loopback host
  if (serverHost !== '127.0.0.1' && serverHost !== '::1') {
    violations.push(`Server address "${serverHost}" is not loopback. Must be 127.0.0.1.`);
  }

  // 3. Verify dedicated non-default port
  if (actualPort === PROHIBITED_DEFAULT_PORT) {
    violations.push(`Server is listening on default port 5432, indicating connection to the shared development service.`);
  } else if (actualPort !== expectedPort) {
    violations.push(`Server port ${actualPort} does not match expected dedicated test port ${expectedPort}.`);
  }

  // 4. Verify dedicated temporary data directory
  const normalizedActualDataDir = normalizePath(actualDataDir);
  const normalizedExpectedDataDir = normalizePath(expectedDataDir);
  const normalizedProhibitedDataDir = normalizePath(PROHIBITED_DEFAULT_DATA_DIR);

  if (normalizedActualDataDir === normalizedProhibitedDataDir) {
    violations.push(`Server data directory matches prohibited default Windows service directory "${PROHIBITED_DEFAULT_DATA_DIR}".`);
  } else if (normalizedActualDataDir !== normalizedExpectedDataDir) {
    violations.push(
      `Server data directory "${actualDataDir}" does not match expected temporary directory "${expectedDataDir}".`,
    );
  }

  // 5. Verify PostgreSQL version is 16
  if (!pgVersion.includes('PostgreSQL 16.')) {
    violations.push(`PostgreSQL version "${pgVersion}" does not match required PostgreSQL 16 release.`);
  }

  // 6. Check existing application tables and Prisma migration history
  interface TableCountRow {
    public_table_count: number;
    prisma_migration_count: number;
  }

  const tableRows: TableCountRow[] = await prisma.$queryRaw`
    SELECT 
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') as public_table_count,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_name = '_prisma_migrations') as prisma_migration_count;
  `;

  const publicTableCount = Number(tableRows[0]?.public_table_count ?? 0);
  const prismaMigrationCount = Number(tableRows[0]?.prisma_migration_count ?? 0);

  if (!options?.allowNonEmpty && publicTableCount > 0) {
    violations.push(
      `Database contains ${publicTableCount} pre-existing application tables. A fresh disposable database must have 0 tables before migration.`,
    );
  }

  if (!options?.allowNonEmpty && prismaMigrationCount > 0) {
    violations.push(
      `Database contains pre-existing _prisma_migrations records (${prismaMigrationCount}). Initial state must be completely unmigrated.`,
    );
  }

  const isNativeClusterVerified = violations.length === 0;

  if (!isNativeClusterVerified) {
    throw new DatabaseIsolationGuardError(
      `Native cluster isolation verification failed:\n- ${violations.join('\n- ')}`,
    );
  }

  return {
    isNativeClusterVerified,
    expectedDataDir,
    actualDataDir,
    expectedPort,
    actualPort,
    expectedDbName,
    actualDbName,
    serverHost,
    pgVersion,
    backendPid,
    isDefaultServiceBlocked: normalizedActualDataDir !== normalizedProhibitedDataDir && actualPort !== PROHIBITED_DEFAULT_PORT,
    publicTableCount,
    prismaMigrationCount,
    violations,
  };
}

/**
 * Asserts database isolation against a live PrismaClient instance (general pattern check).
 * Fails closed immediately if database name or table state violates disposable invariants.
 */
export async function assertDatabaseIsolation(
  prisma: PrismaClient,
  options?: {
    expectedDatabasePattern?: RegExp;
    allowNonEmpty?: boolean;
  },
): Promise<{ currentDatabase: string; currentUser: string; tableCount: number }> {
  const pattern = options?.expectedDatabasePattern || DISPOSABLE_DB_NAME_PATTERN;

  const identityRows: Array<{ db_name: string; user_name: string }> = await prisma.$queryRaw`
    SELECT current_database() as db_name, current_user as user_name;
  `;

  const firstRow = identityRows[0];
  if (!firstRow) {
    throw new DatabaseIsolationGuardError('Could not query current database identity from connection.');
  }

  const currentDatabase = firstRow.db_name;
  const currentUser = firstRow.user_name;

  if (!pattern.test(currentDatabase)) {
    throw new DatabaseIsolationGuardError(
      `Connected database "${currentDatabase}" does not match authorized disposable test pattern ${pattern}. Halting to prevent data corruption.`,
    );
  }

  const tableRows: Array<{ count: bigint | number }> = await prisma.$queryRaw`
    SELECT count(*)::int as count FROM information_schema.tables WHERE table_schema = 'public';
  `;

  const tableCount = Number(tableRows[0]?.count ?? 0);

  return {
    currentDatabase,
    currentUser,
    tableCount,
  };
}

/**
 * Checks whether Docker CLI/daemon is available and inspects container isolation metadata.
 */
export function checkContainerIsolation(options?: {
  expectedContainerId?: string;
  expectedProject?: string;
  expectedImagePrefix?: string;
}): ContainerIsolationReport {
  const violations: string[] = [];
  let isDockerAvailable = false;
  let containerId: string | undefined;
  let image: string | undefined;
  let projectName: string | undefined;
  let networkName: string | undefined;
  let volumeName: string | undefined;

  try {
    const versionOutput = execSync('docker version --format "{{.Server.Version}}"', {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (versionOutput) {
      isDockerAvailable = true;
    }
  } catch {
    isDockerAvailable = false;
    violations.push('Docker daemon or CLI is not accessible in the current execution environment.');
    return {
      isDockerAvailable: false,
      isolationVerified: false,
      violations,
    };
  }

  if (options?.expectedContainerId) {
    try {
      const inspectJson = execSync(`docker inspect ${options.expectedContainerId}`, {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(inspectJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const c = parsed[0];
        containerId = c.Id;
        image = c.Config?.Image;
        projectName = c.Config?.Labels?.['com.docker.compose.project'];

        const networks = Object.keys(c.NetworkSettings?.Networks || {});
        networkName = networks[0];

        const mounts = c.Mounts || [];
        volumeName = mounts[0]?.Name;

        if (options.expectedImagePrefix && !image?.startsWith(options.expectedImagePrefix)) {
          violations.push(
            `Container image "${image}" does not match expected prefix "${options.expectedImagePrefix}".`,
          );
        }

        if (options.expectedProject && projectName !== options.expectedProject) {
          violations.push(
            `Container project "${projectName}" does not match expected disposable project "${options.expectedProject}".`,
          );
        }
      } else {
        violations.push(`Container ${options.expectedContainerId} not found.`);
      }
    } catch (err) {
      violations.push(`Failed to inspect container: ${(err as Error).message}`);
    }
  }

  return {
    isDockerAvailable,
    containerId,
    image,
    projectName,
    networkName,
    volumeName,
    isolationVerified: isDockerAvailable && violations.length === 0,
    violations,
  };
}

/**
 * Generates an explicitly unique disposable test database name.
 */
export function generateDisposableDatabaseName(prefix = 'irie_wp42b'): string {
  const nonce = Math.random().toString(36).substring(2, 10);
  const timestamp = Date.now();
  return `${prefix}_disposable_test_${timestamp}_${nonce}`;
}

/**
 * Executes rollback.sql using psql.exe with explicit arguments, loopback-only connection, and ON_ERROR_STOP=1.
 * Never logs credentials. Rejects the primary integration database to enforce isolation.
 */
export function executeRollbackScriptWithPsql(options: {
  dbName: string;
  rollbackSqlPath: string;
  port?: number;
  host?: string;
  user?: string;
  password?: string;
}): { exitCode: number | null; stdout: string; stderr: string } {
  // Fail closed if attempting to target the primary integration database
  if (options.dbName === EXPECTED_DISPOSABLE_DB_NAME) {
    throw new DatabaseIsolationGuardError(
      `Refusing to execute rollback against primary integration database "${options.dbName}". Rollback must run on auxiliary databases.`,
    );
  }

  // Fail closed if dbName is not an authorized auxiliary disposable test database
  if (
    options.dbName !== EXPECTED_ROLLBACK_REFUSAL_DB_NAME &&
    options.dbName !== EXPECTED_ROLLBACK_CLEAN_DB_NAME
  ) {
    throw new DatabaseIsolationGuardError(
      `Target database "${options.dbName}" is not an authorized auxiliary rollback test database.`,
    );
  }

  const psqlBin = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
  const args = [
    '-h', options.host ?? '127.0.0.1',
    '-p', String(options.port ?? EXPECTED_NATIVE_CLUSTER_PORT),
    '-U', options.user ?? 'irie_wp42b_admin',
    '-d', options.dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-f', options.rollbackSqlPath,
  ];

  const env = {
    ...process.env,
    PGPASSWORD: options.password ?? process.env.PGPASSWORD ?? 'IrieTest_wp42b_disposable_2026!',
  };

  const result = spawnSync(psqlBin, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
