import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  ApproveRefundReconciliationDto,
  ExecuteRefundReconciliationDto,
  ListRefundApprovalsQueryDto,
  RejectRefundReconciliationDto,
  RequestRefundReconciliationDto,
  RevokeRefundReconciliationDto,
} from '../dto/refund-reconciliation.dto';
import {
  RefundApprovalResponseEntity,
  RefundObligationInspectionResponseEntity,
  RefundReconciliationExecutionResponseEntity,
  toApprovalResponseEntity,
  toExecutionResponseEntity,
} from '../entities/refund-reconciliation-response.entity';
import {
  ActiveAdministratorGuard,
  RefundReconciliationEndpointGateGuard,
} from '../guards/refund-reconciliation-endpoint-gate.guard';
import { RefundDualControlReconciliationService } from '../services/refund-dual-control-reconciliation.service';

@ApiTags('admin-refund-reconciliation')
@ApiBearerAuth()
@UseGuards(RefundReconciliationEndpointGateGuard, JwtAuthGuard, RolesGuard, ActiveAdministratorGuard)
@Roles(RoleName.ADMINISTRATOR)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('admin/refund-reconciliation')
export class RefundReconciliationController {
  constructor(
    private readonly reconciliationService: RefundDualControlReconciliationService,
  ) {}

  @Get('approvals')
  @ApiOperation({ summary: 'List refund reconciliation dual-control approval requests' })
  @ApiResponseDoc({ status: 200, type: [RefundApprovalResponseEntity] })
  async listApprovals(
    @Query() query: ListRefundApprovalsQueryDto,
  ): Promise<RefundApprovalResponseEntity[]> {
    const views = await this.reconciliationService.listApprovals(query);
    return views.map(toApprovalResponseEntity);
  }

  @Get('obligations/:obligationId')
  @ApiOperation({ summary: 'Inspect a refund obligation and its dual-control reconciliation history' })
  @ApiResponseDoc({ status: 200, type: RefundObligationInspectionResponseEntity })
  async inspectObligation(
    @Param('obligationId', new ParseUUIDPipe()) obligationId: string,
  ): Promise<RefundObligationInspectionResponseEntity> {
    const view = await this.reconciliationService.inspectObligation(obligationId);
    return {
      ...view,
      reconciliationApprovals: view.reconciliationApprovals.map(toApprovalResponseEntity),
    };
  }

  @Get('approvals/:approvalId')
  @ApiOperation({ summary: 'Inspect a single dual-control reconciliation approval and event log' })
  @ApiResponseDoc({ status: 200, type: RefundApprovalResponseEntity })
  async getApproval(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
  ): Promise<RefundApprovalResponseEntity> {
    const view = await this.reconciliationService.inspectApprovalById(approvalId);
    return toApprovalResponseEntity(view);
  }

  @Post('approvals')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a dual-control refund reconciliation approval' })
  @ApiResponseDoc({ status: 201, type: RefundApprovalResponseEntity })
  async requestApproval(
    @CurrentUser() user: RequestUser,
    @Body() dto: RequestRefundReconciliationDto,
  ): Promise<RefundApprovalResponseEntity> {
    const view = await this.reconciliationService.requestReconciliation({
      obligationId: dto.obligationId,
      attemptId: dto.attemptId ?? null,
      requestedOutcome: dto.requestedOutcome,
      evidenceType: dto.evidenceType,
      externalSettlementReference: dto.externalSettlementReference ?? null,
      evidenceReceiptIds: dto.evidenceReceiptIds,
      rawEvidence: dto.rawEvidence,
      evidenceDigest: dto.evidenceDigest ?? null,
      rationale: dto.rationale,
      ttlMs: dto.ttlMs,
      requestedByActorId: user.id,
      actorRole: RoleName.ADMINISTRATOR,
    });
    return toApprovalResponseEntity(view);
  }

  @Post('approvals/:approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Second-administrator grant of a pending reconciliation approval' })
  @ApiResponseDoc({ status: 200, type: RefundApprovalResponseEntity })
  async approveApproval(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ApproveRefundReconciliationDto,
  ): Promise<RefundApprovalResponseEntity> {
    let parsedExpiresAt: Date | undefined;
    if (dto.expiresAt !== undefined) {
      parsedExpiresAt = new Date(dto.expiresAt);
      if (Number.isNaN(parsedExpiresAt.getTime())) {
        throw new BadRequestException('Invalid expiresAt timestamp');
      }
    }

    const view = await this.reconciliationService.approveReconciliation({
      approvalId,
      approvedByActorId: user.id,
      actorRole: RoleName.ADMINISTRATOR,
      expectedAuthorizationRevision: dto.expectedAuthorizationRevision,
      expectedEvidenceDigest: dto.expectedEvidenceDigest ?? null,
      expiresAt: parsedExpiresAt,
    });
    return toApprovalResponseEntity(view);
  }

  @Post('approvals/:approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending reconciliation approval request' })
  @ApiResponseDoc({ status: 200, type: RefundApprovalResponseEntity })
  async rejectApproval(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: RejectRefundReconciliationDto,
  ): Promise<RefundApprovalResponseEntity> {
    const view = await this.reconciliationService.rejectReconciliation({
      approvalId,
      rejectedByActorId: user.id,
      actorRole: RoleName.ADMINISTRATOR,
      rejectionReason: dto.rejectionReason,
    });
    return toApprovalResponseEntity(view);
  }

  @Post('approvals/:approvalId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a pending or approved reconciliation request before execution' })
  @ApiResponseDoc({ status: 200, type: RefundApprovalResponseEntity })
  async revokeApproval(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: RevokeRefundReconciliationDto,
  ): Promise<RefundApprovalResponseEntity> {
    const view = await this.reconciliationService.revokeReconciliation({
      approvalId,
      revokedByActorId: user.id,
      actorRole: RoleName.ADMINISTRATOR,
      revocationReason: dto.revocationReason,
    });
    return toApprovalResponseEntity(view);
  }

  @Post('approvals/:approvalId/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atomically execute an approved dual-control refund reconciliation' })
  @ApiResponseDoc({ status: 200, type: RefundReconciliationExecutionResponseEntity })
  async executeApproval(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ExecuteRefundReconciliationDto,
  ): Promise<RefundReconciliationExecutionResponseEntity> {
    const result = await this.reconciliationService.executeReconciliation({
      approvalId,
      executedByActorId: user.id,
      actorRole: RoleName.ADMINISTRATOR,
      expectedAuthorizationRevision: dto.expectedAuthorizationRevision,
      expectedEvidenceDigest: dto.expectedEvidenceDigest ?? null,
    });

    const entity = toExecutionResponseEntity(result);
    if (!result.applied) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: result.expired ? 'RECONCILIATION_APPROVAL_EXPIRED' : 'RECONCILIATION_QUARANTINED',
        message: result.message,
        result: entity,
      });
    }

    return entity;
  }
}
