import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateComplianceDocumentDto } from '../dto/create-compliance-document.dto';
import { ListComplianceDocumentsDto } from '../dto/list-compliance-documents.dto';
import { ComplianceDocumentResponseEntity } from '../entities/compliance-document-response.entity';
import { ComplianceDocumentsService } from '../services/compliance-documents.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/documents')
export class ComplianceDocumentsController {
  constructor(private readonly documentsService: ComplianceDocumentsService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a compliance document, versioned per documentType+lot/recall (admin only)' })
  @ApiResponseDoc({ status: 201, type: ComplianceDocumentResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateComplianceDocumentDto,
  ): Promise<ComplianceDocumentResponseEntity> {
    return this.documentsService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List compliance documents for a lot or recall (admin only)' })
  @ApiResponseDoc({ status: 200, type: ComplianceDocumentResponseEntity, isArray: true })
  list(@Query() dto: ListComplianceDocumentsDto): Promise<ComplianceDocumentResponseEntity[]> {
    return this.documentsService.list(dto);
  }
}
