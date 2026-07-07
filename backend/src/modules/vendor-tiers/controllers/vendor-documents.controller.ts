import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ReviewVendorDocumentDto } from '../dto/review-vendor-document.dto';
import { UploadVendorDocumentDto } from '../dto/upload-vendor-document.dto';
import { VendorDocumentResponseEntity } from '../entities/vendor-document-response.entity';
import { VendorDocumentsService } from '../services/vendor-documents.service';

@ApiTags('vendor-documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vendor-documents')
export class VendorDocumentsController {
  constructor(private readonly documentsService: VendorDocumentsService) {}

  @Post()
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: 'Upload a compliance document for the authenticated vendor' })
  @ApiResponseDoc({ status: 201, type: VendorDocumentResponseEntity })
  upload(
    @CurrentUser() user: RequestUser,
    @Body() dto: UploadVendorDocumentDto,
  ): Promise<VendorDocumentResponseEntity> {
    return this.documentsService.upload(user.id, dto);
  }

  @Get('mine')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: "List the authenticated vendor's documents" })
  @ApiResponseDoc({ status: 200, type: VendorDocumentResponseEntity, isArray: true })
  listMine(@CurrentUser() user: RequestUser): Promise<VendorDocumentResponseEntity[]> {
    return this.documentsService.listMine(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: 'Remove one of the authenticated vendor\'s non-approved documents' })
  @ApiResponseDoc({ status: 204 })
  async removeMine(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<void> {
    await this.documentsService.removeMine(user.id, id);
  }

  @Get('vendor/:vendorId')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: "List a vendor's documents (admin only)" })
  @ApiResponseDoc({ status: 200, type: VendorDocumentResponseEntity, isArray: true })
  listForVendor(@Param('vendorId') vendorId: string): Promise<VendorDocumentResponseEntity[]> {
    return this.documentsService.listForVendor(vendorId);
  }

  @Patch(':id/review')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Approve or reject a pending vendor document (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorDocumentResponseEntity })
  review(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ReviewVendorDocumentDto,
  ): Promise<VendorDocumentResponseEntity> {
    return this.documentsService.review(user.id, id, dto);
  }
}
