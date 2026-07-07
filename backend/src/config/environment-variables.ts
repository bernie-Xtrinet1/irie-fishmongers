import { IsIn, IsInt, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsIn([NodeEnv.Development, NodeEnv.Test, NodeEnv.Production])
  NODE_ENV!: NodeEnv;

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

  // The customer-facing web app's origin (apps/web) - the only origin
  // allowed to call this API cross-origin. Distinct from APP_BASE_URL,
  // which is this backend's OWN base URL (used for webhook callback links).
  @IsUrl({ require_tld: false, require_protocol: true })
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
