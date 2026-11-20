import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const SHA256_HEX_REGEX = /^[a-fA-F0-9]{64}$/;

export class ListRefundApprovalsQueryDto {
  @ApiPropertyOptional({ description: 'Filter approvals by refund obligation UUID' })
  @IsOptional()
  @IsUUID()
  obligationId?: string;

  @ApiPropertyOptional({ enum: RefundReconciliationApprovalStatus })
  @IsOptional()
  @IsEnum(RefundReconciliationApprovalStatus)
  status?: RefundReconciliationApprovalStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class RequestRefundReconciliationDto {
  @ApiProperty({ description: 'Target RefundObligation UUID' })
  @IsUUID()
  obligationId!: string;

  @ApiPropertyOptional({ description: 'Specific RefundProviderAttempt UUID to reconcile' })
  @IsOptional()
  @IsUUID()
  attemptId?: string;

  @ApiProperty({ enum: RefundReconciliationOutcome })
  @IsEnum(RefundReconciliationOutcome)
  requestedOutcome!: RefundReconciliationOutcome;

  @ApiProperty({ maxLength: 120, example: 'AUTHENTICATED_SETTLEMENT_PORTAL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  evidenceType!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalSettlementReference?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  evidenceReceiptIds?: string[];

  @ApiPropertyOptional({
    description: 'Precomputed SHA-256 hex digest of verified gateway evidence',
  })
  @IsOptional()
  @IsString()
  @Matches(SHA256_HEX_REGEX, {
    message: 'evidenceDigest must be a 64-character SHA-256 hex string',
  })
  evidenceDigest?: string;

  @ApiPropertyOptional({
    description: 'Non-secret summary metadata hashed server-side into evidenceDigest (never persisted raw)',
  })
  @IsOptional()
  @IsObject()
  rawEvidence?: Record<string, unknown>;

  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(1000)
  rationale!: string;

  @ApiPropertyOptional({
    description: 'Approval time-to-live in milliseconds (bounded between 1s and 24h)',
    minimum: 1000,
    maximum: 86_400_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(86_400_000)
  ttlMs?: number;
}

export class ApproveRefundReconciliationDto {
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedAuthorizationRevision?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(SHA256_HEX_REGEX, {
    message: 'expectedEvidenceDigest must be a 64-character SHA-256 hex string',
  })
  expectedEvidenceDigest?: string;

  @ApiPropertyOptional({ description: 'Optional ISO-8601 expiration override before approval grant' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class RejectRefundReconciliationDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(1000)
  rejectionReason!: string;
}

export class RevokeRefundReconciliationDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(1000)
  revocationReason!: string;
}

export class ExecuteRefundReconciliationDto {
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedAuthorizationRevision?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(SHA256_HEX_REGEX, {
    message: 'expectedEvidenceDigest must be a 64-character SHA-256 hex string',
  })
  expectedEvidenceDigest?: string;
}
