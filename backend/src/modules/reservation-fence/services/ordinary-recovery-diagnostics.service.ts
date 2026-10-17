import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { UUID_PATTERN } from '../types/reservation-fence.types';
import {
  ClearBackoffOptions,
  RecoveryBackoffConfig,
  RecoveryBackoffDecision,
  RecoveryDiagnosticRecord,
} from '../types/ordinary-invalidation-recovery.types';

export const invalidationRecoveryBackoffKey = (intentId: string): string =>
  `reservation:fence:recovery:backoff:${intentId}`;

export const DEFAULT_RECOVERY_BACKOFF_CONFIG: RecoveryBackoffConfig = {
  baseDelayMs: 15_000,
  maxDelayMs: 3_600_000,
  factor: 2,
  jitter: true,
  ttlSeconds: 86_400,
};

export interface DiagnosticsServiceOptions extends Partial<RecoveryBackoffConfig> {
  readonly randomFn?: () => number;
}

export const RECORD_FAILURE_LUA = `
local function toIso(msTotal)
  local sec = math.floor(msTotal / 1000)
  local ms = msTotal % 1000
  local z = math.floor(sec / 86400) + 719468
  local era = math.floor((z >= 0 and z or z - 146096) / 146097)
  local doe = z - era * 146097
  local yoe = math.floor((doe - math.floor(doe/1460) + math.floor(doe/36524) - math.floor(doe/146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365*yoe + math.floor(yoe/4) - math.floor(yoe/100))
  local mp = math.floor((5*doy + 2) / 153)
  local d = doy - math.floor((153*mp + 2) / 5) + 1
  local m = mp + (mp < 10 and 3 or -9)
  if m <= 2 then y = y + 1 end
  local sod = sec % 86400
  local h = math.floor(sod / 3600)
  local min = math.floor((sod % 3600) / 60)
  local s = sod % 60
  return string.format('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ', y, m, d, h, min, s, ms)
end

local key = KEYS[1]
local intentId = ARGV[1]
local reason = ARGV[2]
local lastError = ARGV[3]
local workerId = ARGV[4]
local nowMs = tonumber(ARGV[5])
local nowIso = ARGV[6]
local baseDelay = tonumber(ARGV[7])
local maxDelay = tonumber(ARGV[8])
local factor = tonumber(ARGV[9])
local ttlSeconds = tonumber(ARGV[10])
local jitterMult = tonumber(ARGV[11])

local raw = redis.call('GET', key)
local attempts = 1
local createdAt = nowIso

if raw then
  local ok, existing = pcall(cjson.decode, raw)
  if ok and type(existing) == 'table' and existing.intentId == intentId then
    local prev = tonumber(existing.attempts)
    if prev and prev >= 1 then
      attempts = prev + 1
    end
    if existing.createdAt and type(existing.createdAt) == 'string' then
      createdAt = existing.createdAt
    end
  end
end

local exponent = math.max(0, attempts - 1)
local rawDelay = baseDelay * math.pow(factor, exponent)
local cappedDelay = math.min(maxDelay, math.max(baseDelay, rawDelay))
local jittered = math.min(maxDelay, math.floor(cappedDelay * jitterMult))
local nextAttemptMs = nowMs + jittered
local nextAttemptIso = toIso(nextAttemptMs)

local record = {
  intentId = intentId,
  attempts = attempts,
  nextAttemptAt = nextAttemptIso,
  reason = reason ~= '' and reason or nil,
  lastError = lastError ~= '' and lastError or nil,
  lastWorkerId = workerId ~= '' and workerId or nil,
  createdAt = createdAt,
  updatedAt = nowIso
}

local payload = cjson.encode(record)
redis.call('SET', key, payload, 'EX', ttlSeconds)
return payload
`;

export const CLEAR_BACKOFF_LUA = `
local key = KEYS[1]
local intentId = ARGV[1]
local isConditional = ARGV[2]
local expectedUpdatedAt = ARGV[3]
local maxAttemptsStr = ARGV[4]

local raw = redis.call('GET', key)
if not raw then return 0 end

local ok, existing = pcall(cjson.decode, raw)
if not ok or type(existing) ~= 'table' then
  return 0
end

if not existing.intentId or tostring(existing.intentId) ~= intentId then
  return 0
end

if isConditional == '1' then
  local att = tonumber(existing.attempts)
  if not att or att < 1 or math.floor(att) ~= att then
    return 0
  end

  if expectedUpdatedAt and expectedUpdatedAt ~= '' then
    if not existing.updatedAt or type(existing.updatedAt) ~= 'string' or existing.updatedAt ~= expectedUpdatedAt then
      return 0
    end
  end

  if maxAttemptsStr and maxAttemptsStr ~= '' then
    local maxAtt = tonumber(maxAttemptsStr)
    if not maxAtt or maxAtt < 1 or math.floor(maxAtt) ~= maxAtt or att > maxAtt then
      return 0
    end
  end
end

return redis.call('DEL', key)
`;

@Injectable()
export class OrdinaryRecoveryDiagnosticsService {
  private readonly logger = new Logger(OrdinaryRecoveryDiagnosticsService.name);
  readonly config: RecoveryBackoffConfig;
  private readonly randomFn: () => number;

  constructor(
    private readonly redis: RedisService,
    @Optional() options?: DiagnosticsServiceOptions,
  ) {
    this.config = {
      baseDelayMs: options?.baseDelayMs ?? DEFAULT_RECOVERY_BACKOFF_CONFIG.baseDelayMs,
      maxDelayMs: options?.maxDelayMs ?? DEFAULT_RECOVERY_BACKOFF_CONFIG.maxDelayMs,
      factor: options?.factor ?? DEFAULT_RECOVERY_BACKOFF_CONFIG.factor,
      jitter: options?.jitter ?? DEFAULT_RECOVERY_BACKOFF_CONFIG.jitter,
      ttlSeconds: options?.ttlSeconds ?? DEFAULT_RECOVERY_BACKOFF_CONFIG.ttlSeconds,
    };
    this.randomFn = options?.randomFn ?? Math.random;
  }

  computeDelay(attempts: number): number {
    if (attempts <= 0) return 0;
    const exponent = Math.max(0, attempts - 1);
    const rawDelay = this.config.baseDelayMs * Math.pow(this.config.factor, exponent);
    const cappedDelay = Math.min(this.config.maxDelayMs, Math.max(this.config.baseDelayMs, rawDelay));

    if (!this.config.jitter) {
      return Math.round(cappedDelay);
    }

    // Apply bounded jitter: [0.8, 1.2] multiplier
    const jitterMultiplier = 0.8 + this.randomFn() * 0.4;
    const jittered = Math.round(cappedDelay * jitterMultiplier);
    return Math.min(this.config.maxDelayMs, jittered);
  }

  async getBackoff(intentId: string, nowMs = Date.now()): Promise<RecoveryBackoffDecision> {
    if (!this.isValidId(intentId)) {
      return { shouldRetry: false, remainingWaitMs: 0, attempts: 0 };
    }

    try {
      const record = await this.getDiagnostics(intentId);
      if (!record) {
        return { shouldRetry: true, remainingWaitMs: 0, attempts: 0 };
      }

      const nextAttemptTime = new Date(record.nextAttemptAt).getTime();
      if (Number.isNaN(nextAttemptTime)) {
        return { shouldRetry: true, remainingWaitMs: 0, attempts: record.attempts, reason: record.reason };
      }

      const remainingWaitMs = Math.max(0, nextAttemptTime - nowMs);
      if (remainingWaitMs === 0) {
        return {
          shouldRetry: true,
          remainingWaitMs: 0,
          attempts: record.attempts,
          nextAttemptAt: new Date(nextAttemptTime),
          reason: record.reason,
        };
      }

      return {
        shouldRetry: false,
        remainingWaitMs,
        attempts: record.attempts,
        nextAttemptAt: new Date(nextAttemptTime),
        reason: record.reason,
      };
    } catch (err) {
      this.logger.warn(`Redis outage while reading backoff for ${intentId}: ${String(err)}`);
      // Fail-safe: Redis outage does not block recovery
      return { shouldRetry: true, remainingWaitMs: 0, attempts: 0 };
    }
  }

  async recordFailure(
    intentId: string,
    reason: string,
    error?: string,
    workerId?: string,
    nowMs = Date.now(),
  ): Promise<RecoveryDiagnosticRecord> {
    if (!this.isValidId(intentId)) {
      throw new Error('INVALID_INTENT_ID');
    }

    const nowIso = new Date(nowMs).toISOString();
    const jitterMult = this.config.jitter ? 0.8 + this.randomFn() * 0.4 : 1.0;
    const key = invalidationRecoveryBackoffKey(intentId);

    try {
      const raw = await this.redis.eval(
        RECORD_FAILURE_LUA,
        [key],
        [
          intentId,
          reason ?? '',
          error ?? '',
          workerId ?? '',
          nowMs,
          nowIso,
          this.config.baseDelayMs,
          this.config.maxDelayMs,
          this.config.factor,
          this.config.ttlSeconds,
          jitterMult.toFixed(6),
        ],
      );

      if (typeof raw === 'string') {
        const parsed: unknown = JSON.parse(raw);
        if (this.isValidRecord(parsed, intentId)) {
          return parsed;
        }
      }
    } catch (err) {
      this.logger.warn(`Redis outage while recording failure for ${intentId}: ${String(err)}`);
    }

    // Fallback in-memory record generation during Redis outage
    const delayMs = this.computeDelay(1);
    const nextAttemptAt = new Date(nowMs + delayMs).toISOString();
    return {
      intentId,
      attempts: 1,
      nextAttemptAt,
      reason,
      lastError: error,
      lastWorkerId: workerId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  async clearBackoff(intentId: string, options?: ClearBackoffOptions): Promise<boolean> {
    if (!this.isValidId(intentId)) return false;

    let isConditional = '0';
    let expectedUpdatedAt = '';
    let maxAttemptsStr = '';

    if (options !== undefined) {
      isConditional = '1';

      const hasUpdatedAt = options.ifMatchesUpdatedAt !== undefined;
      const hasAttempts = options.ifAttemptsLessThanOrEqual !== undefined;

      // Caller supplied options, so at least one constraint is required
      if (!hasUpdatedAt && !hasAttempts) {
        return false;
      }

      if (hasUpdatedAt) {
        if (
          typeof options.ifMatchesUpdatedAt !== 'string' ||
          options.ifMatchesUpdatedAt.trim() === ''
        ) {
          return false;
        }
        expectedUpdatedAt = options.ifMatchesUpdatedAt;
      }

      if (hasAttempts) {
        const max = options.ifAttemptsLessThanOrEqual;
        if (
          typeof max !== 'number' ||
          !Number.isFinite(max) ||
          !Number.isInteger(max) ||
          max < 1
        ) {
          return false;
        }
        maxAttemptsStr = String(max);
      }
    }

    try {
      const key = invalidationRecoveryBackoffKey(intentId);
      const result = await this.redis.eval(
        CLEAR_BACKOFF_LUA,
        [key],
        [intentId, isConditional, expectedUpdatedAt, maxAttemptsStr],
      );
      return result === 1;
    } catch (err) {
      this.logger.warn(`Redis outage while clearing backoff for ${intentId}: ${String(err)}`);
      return false;
    }
  }

  async getDiagnostics(intentId: string): Promise<RecoveryDiagnosticRecord | null> {
    if (!this.isValidId(intentId)) return null;

    try {
      const key = invalidationRecoveryBackoffKey(intentId);
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      if (!this.isValidRecord(parsed, intentId)) {
        this.logger.warn(`Malformed recovery diagnostic record for ${intentId}`);
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  private isValidId(intentId: string): boolean {
    return typeof intentId === 'string' && intentId.length === 36 && UUID_PATTERN.test(intentId);
  }

  private isValidRecord(value: unknown, expectedIntentId: string): value is RecoveryDiagnosticRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const rec = value as Record<string, unknown>;
    return (
      rec.intentId === expectedIntentId &&
      typeof rec.attempts === 'number' &&
      Number.isInteger(rec.attempts) &&
      rec.attempts > 0 &&
      typeof rec.nextAttemptAt === 'string' &&
      typeof rec.createdAt === 'string' &&
      typeof rec.updatedAt === 'string'
    );
  }
}
