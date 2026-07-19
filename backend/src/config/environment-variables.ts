import { IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, Min, MinLength } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsIn([NodeEnv.Development, NodeEnv.Test, NodeEnv.Production])
  NODE_ENV!: NodeEnv;

  // Explicit master switch for the timer-driven @Cron jobs
  // (ScheduleModule.forRoot). Optional; anything other than the string
  // 'false' leaves scheduling ENABLED, so dev/prod behaviour is unchanged
  // when the var is absent. The e2e suite sets it to 'false' so wall-clock
  // cron ticks (the every-5-min SLA sweep) can't fire mid-run and race a
  // suite's teardown. Deliberately its OWN flag, not derived from NODE_ENV,
  // so scheduling can be toggled independently (e.g. a scheduler-specific
  // test run, or disabling crons on a read-replica instance).
  @IsOptional()
  @IsIn(['true', 'false'])
  ENABLE_SCHEDULER?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @MinLength(1)
  API_PREFIX!: string;

  @IsUrl({ protocols: ['postgresql', 'postgres'], require_tld: false, require_protocol: true })
  DATABASE_URL!: string;

  @IsUrl({ protocols: ['redis', 'rediss'], require_tld: false, require_protocol: true })
  REDIS_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(1)
  JWT_ACCESS_EXPIRES_IN!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(1)
  JWT_REFRESH_EXPIRES_IN!: string;

  @IsUrl({ require_tld: false })
  APP_BASE_URL!: string;

  // Comma-separated allowlist of origins allowed to call this API
  // cross-origin (e.g. the customer web app + the admin dashboard).
  // Distinct from APP_BASE_URL, which is this backend's OWN base URL
  // (used for webhook callback links). Never '*' - incompatible with the
  // credentials: true CORS config main.ts uses for cookie-based auth.
  @IsString()
  @Matches(/^https?:\/\/[^\s,]+(,\s*https?:\/\/[^\s,]+)*$/, {
    message: 'CORS_ORIGIN must be a comma-separated list of http(s) URLs',
  })
  CORS_ORIGIN!: string;

  @IsUrl({ require_tld: false })
  WIPAY_API_URL!: string;

  @IsString()
  @MinLength(1)
  WIPAY_ACCOUNT_NUMBER!: string;

  @IsString()
  @MinLength(1)
  WIPAY_API_KEY!: string;

  @IsString()
  @MinLength(1)
  SENDGRID_API_KEY!: string;

  @IsString()
  @MinLength(1)
  SENDGRID_FROM_EMAIL!: string;

  @IsString()
  @MinLength(1)
  FCM_SERVER_KEY!: string;
}
