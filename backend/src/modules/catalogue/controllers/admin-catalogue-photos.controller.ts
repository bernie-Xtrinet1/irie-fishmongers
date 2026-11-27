import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Response } from 'express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  ApproveCataloguePhotoDto,
  BulkSwitchListingPhotosDto,
  QueryAdminCataloguePhotosDto,
  RejectCataloguePhotoDto,
  ReplaceCataloguePhotoDto,
  RetireCataloguePhotoDto,
  UpdateCataloguePhotoMetadataDto,
  UploadCataloguePhotoDto,
} from '../dto/admin-catalogue-photo.dto';
import { CataloguePhotoAdminGuard } from '../guards/catalogue-photo-admin.guard';
import { CataloguePhotoManageGuard } from '../guards/catalogue-photo-manage.guard';
import { CataloguePhotoViewGuard } from '../guards/catalogue-photo-view.guard';
import { AdminCataloguePhotosService } from '../services/admin-catalogue-photos.service';
import { MAX_CATALOGUE_IMAGE_BYTES } from '../utils/image-validation.util';

@ApiTags('Admin Catalogue Photos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
@Controller('admin/catalogue-photos')
export class AdminCataloguePhotosController {
  constructor(private readonly service: AdminCataloguePhotosService) {}

  @Get()
  @UseGuards(CataloguePhotoViewGuard)
  @ApiOperation({
    summary: 'List all catalogue photos across drafts, published, rejected, and retired states',
  })
  async list(@Query() query: QueryAdminCataloguePhotosDto) {
    return this.service.list(query);
  }

  @Get(':id/history')
  @UseGuards(CataloguePhotoViewGuard)
  @ApiOperation({ summary: 'Get version lineage and audit log history for a catalogue photo' })
  async getHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getHistory(id);
  }

  @Get(':id/image')
  @UseGuards(CataloguePhotoViewGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Stream authorized image bytes (keeps draft photos private)' })
  async streamImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { buffer, mimeType } = await this.service.getProtectedImageBuffer(id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buffer);
  }

  @Post()
  @UseGuards(CataloguePhotoManageGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_CATALOGUE_IMAGE_BYTES + 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a private draft catalogue photo for a species' })
  async uploadDraft(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadCataloguePhotoDto,
  ) {
    return this.service.uploadDraft(user, file, dto);
  }

  @Patch(':id')
  @UseGuards(CataloguePhotoManageGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_CATALOGUE_IMAGE_BYTES + 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Edit catalogue photo metadata, aliases, or private draft image' })
  async updateMetadata(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UpdateCataloguePhotoMetadataDto,
  ) {
    return this.service.updateMetadata(user, id, dto, file);
  }

  @Post(':id/replace')
  @UseGuards(CataloguePhotoManageGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_CATALOGUE_IMAGE_BYTES + 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a new replacement version under a new storage key while keeping existing listings on their selected version by default',
  })
  async replacePhoto(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ReplaceCataloguePhotoDto,
  ) {
    return this.service.replacePhoto(user, id, file, dto);
  }

  @Post(':id/approve')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({ summary: 'Approve and publish a draft photo to Blob Storage and the vendor picker' })
  async approveAndPublish(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveCataloguePhotoDto,
  ) {
    return this.service.approveAndPublish(user, id, dto);
  }

  @Post(':id/reject')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({ summary: 'Reject a draft photo without publishing it' })
  async rejectDraft(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCataloguePhotoDto,
  ) {
    return this.service.rejectDraft(user, id, dto);
  }

  @Post(':id/set-default')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({ summary: 'Set an approved catalogue photo as the default selection for its species' })
  async setDefault(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.setDefault(user, id);
  }

  @Post(':id/retire')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({
    summary: 'Retire a catalogue photo from new vendor selections while retaining existing listings and history',
  })
  async retire(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireCataloguePhotoDto,
  ) {
    return this.service.retire(user, id, dto);
  }

  @Post(':id/restore')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({ summary: 'Roll back retirement and restore a previously approved photo version' })
  async restore(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.restore(user, id);
  }

  @Post(':id/switch-listings')
  @Roles(RoleName.ADMINISTRATOR)
  @UseGuards(CataloguePhotoAdminGuard)
  @ApiOperation({
    summary:
      'Explicitly switch existing product listings from an older photo version to this approved replacement',
  })
  async bulkSwitchListings(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkSwitchListingPhotosDto,
  ) {
    return this.service.bulkSwitchListings(user, id, dto);
  }
}
