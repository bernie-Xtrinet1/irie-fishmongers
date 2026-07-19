import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ComplianceScoreExplanationEntity } from '../entities/compliance-score-explanation.entity';
import { ComplianceScoreService } from '../services/compliance-score.service';

@ApiTags('admin-compliance-scores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('admin/vendors/:vendorId/compliance-score')
export class ComplianceScoreController {
  constructor(private readonly complianceScoreService: ComplianceScoreService) {}

  @Get()
  @ApiOperation({ summary: "Explain a vendor's compliance score with its per-category breakdown (admin only)" })
  @ApiResponseDoc({ status: 200, type: ComplianceScoreExplanationEntity })
  describe(@Param('vendorId', new ParseUUIDPipe()) vendorId: string): Promise<ComplianceScoreExplanationEntity> {
    return this.complianceScoreService.describe(vendorId);
  }

  @Post('recompute')
  @ApiOperation({ summary: "Force an immediate recompute of a vendor's compliance score (admin only)" })
  @ApiResponseDoc({ status: 201, type: ComplianceScoreExplanationEntity })
  async recompute(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
  ): Promise<ComplianceScoreExplanationEntity> {
    await this.complianceScoreService.recompute(vendorId);
    return this.complianceScoreService.describe(vendorId);
  }
}
