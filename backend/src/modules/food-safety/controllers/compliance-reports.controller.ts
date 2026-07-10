import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Response } from 'express';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { toCsv } from '../../../common/utils/csv.util';
import { ReportFormatDto } from '../dto/report-format.dto';
import { ComplianceReportsService, ReportRow } from '../services/compliance-reports.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/reports')
export class ComplianceReportsController {
  constructor(private readonly reportsService: ComplianceReportsService) {}

  @Get('traceability')
  @ApiOperation({ summary: 'Lot traceability report, ?format=csv|json (admin only)' })
  @ApiResponseDoc({ status: 200 })
  async getTraceabilityReport(
    @Query() query: ReportFormatDto,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.reportsService.getTraceabilityReport();
    this.sendReport(res, 'traceability', rows, query.format);
  }

  @Get('temperature-compliance')
  @ApiOperation({ summary: 'Temperature alert history report, ?format=csv|json (admin only)' })
  @ApiResponseDoc({ status: 200 })
  async getTemperatureComplianceReport(
    @Query() query: ReportFormatDto,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.reportsService.getTemperatureComplianceReport();
    this.sendReport(res, 'temperature-compliance', rows, query.format);
  }

  @Get('recalls')
  @ApiOperation({ summary: 'Recall history report, ?format=csv|json (admin only)' })
  @ApiResponseDoc({ status: 200 })
  async getRecallsReport(@Query() query: ReportFormatDto, @Res() res: Response): Promise<void> {
    const rows = await this.reportsService.getRecallsReport();
    this.sendReport(res, 'recalls', rows, query.format);
  }

  // A raw CSV body can't go through ResponseInterceptor's {success,data,error}
  // envelope, so this bypasses it via @Res() - the one controller-level
  // exception to this module's usual "return the entity, let the
  // interceptor wrap it" pattern. JSON stays on the standard envelope.
  private sendReport(
    res: Response,
    reportName: string,
    rows: ReportRow[],
    format: 'json' | 'csv' | undefined,
  ): void {
    if (format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', `attachment; filename="${reportName}.csv"`)
        .send(toCsv(rows));
      return;
    }
    res.status(200).json({ success: true, data: rows, error: null });
  }
}
