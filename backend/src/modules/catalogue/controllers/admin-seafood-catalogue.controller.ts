import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateCatalogueItemDto } from '../dto/create-catalogue-item.dto';
import { CreateRegulatoryOverrideDto } from '../dto/create-regulatory-override.dto';
import { QueryCatalogueDto } from '../dto/query-catalogue.dto';
import { RetireCatalogueItemDto } from '../dto/retire-catalogue-item.dto';
import { UpdateCatalogueItemDto } from '../dto/update-catalogue-item.dto';
import {
  LinkedSpeciesEntity,
  SeafoodCatalogueItemResponseEntity,
} from '../entities/catalogue-item-response.entity';
import { CatalogueItemWithDetails } from '../repositories/seafood-catalogue.repository';
import { SeafoodCatalogueService } from '../services/seafood-catalogue.service';

@ApiTags('Admin Seafood Catalogue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('admin/catalogue')
export class AdminSeafoodCatalogueController {
  constructor(private readonly catalogueService: SeafoodCatalogueService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new draft master catalogue item' })
  async create(
    @Body() dto: CreateCatalogueItemDto,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.create(dto);
    return this.toResponse(item);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing draft or under-review master catalogue item' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogueItemDto,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.update(id, dto);
    return this.toResponse(item);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'List all master catalogue items across all lifecycle states' })
  async listAll(@Query() query: QueryCatalogueDto) {
    const result = await this.catalogueService.findMany(query, false);
    return {
      data: result.items.map((item) => this.toResponse(item)),
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Get(':id')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'Get full details of any master catalogue item' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.findById(id, false);
    return this.toResponse(item);
  }

  @Post(':id/submit-for-review')
  @ApiOperation({ summary: 'Submit a draft catalogue item for compliance/admin review' })
  async submitForReview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.submitForReview(id);
    return this.toResponse(item);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve an under-review catalogue item for publication' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.approve(id);
    return this.toResponse(item);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject an under-review catalogue item back to draft' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('notes') notes?: string,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.reject(id, notes);
    return this.toResponse(item);
  }

  @Post(':id/retire')
  @ApiOperation({ summary: 'Retire a published catalogue item with mandatory reason' })
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireCatalogueItemDto,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.retire(id, dto);
    return this.toResponse(item);
  }

  @Post('overrides')
  @ApiOperation({ summary: 'Request a two-party data-correction regulatory override' })
  async requestOverride(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRegulatoryOverrideDto,
  ) {
    return this.catalogueService.requestRegulatoryOverride(user.id, dto);
  }

  @Post('overrides/:id/approve')
  @ApiOperation({ summary: 'Approve a pending regulatory override (second-party authorization)' })
  async approveOverride(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalogueService.approveRegulatoryOverride(id, user.id);
  }

  private toResponse(item: CatalogueItemWithDetails): SeafoodCatalogueItemResponseEntity {
    return {
      id: item.id,
      name: item.name,
      scientificName: item.scientificName,
      scientificFamily: item.scientificFamily,
      commonName: item.commonName,
      jamaicanNames: item.jamaicanNames,
      description: item.description,
      categoryId: item.categoryId,
      categoryName: item.category?.name,
      compositionMode: item.compositionMode,
      lifecycleStatus: item.lifecycleStatus,
      retirementReason: item.retirementReason,
      retirementNotes: item.retirementNotes,
      consolidatedIntoId: item.consolidatedIntoId,
      referenceImageUrl: item.referenceImageUrl,
      imageSourceLicense: item.imageSourceLicense,
      typicalUnit: item.typicalUnit,
      typicalSizeMinCm: item.typicalSizeMinCm ? item.typicalSizeMinCm.toString() : null,
      typicalSizeMaxCm: item.typicalSizeMaxCm ? item.typicalSizeMaxCm.toString() : null,
      typicalWeightMinLbs: item.typicalWeightMinLbs ? item.typicalWeightMinLbs.toString() : null,
      typicalWeightMaxLbs: item.typicalWeightMaxLbs ? item.typicalWeightMaxLbs.toString() : null,
      species: item.speciesLinks.map((sl): LinkedSpeciesEntity => ({
        speciesId: sl.speciesId,
        scientificName: sl.species.scientificName,
        commercialName: sl.species.commercialName,
        regulatoryStatus: sl.species.regulatoryStatus,
        seasonalStartMonth: sl.species.seasonalStartMonth,
        seasonalEndMonth: sl.species.seasonalEndMonth,
        isPrimary: sl.isPrimary,
        typicalProportion: sl.typicalProportion ? sl.typicalProportion.toString() : null,
      })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
