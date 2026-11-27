import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { EvaluateRegulatoryEligibilityDto } from '../dto/evaluate-regulatory.dto';
import { QueryCatalogueDto } from '../dto/query-catalogue.dto';
import { QueryCataloguePhotosDto } from '../dto/query-catalogue-photos.dto';
import {
  LinkedSpeciesEntity,
  SeafoodCatalogueItemResponseEntity,
} from '../entities/catalogue-item-response.entity';
import { CataloguePhotoEntity } from '../entities/catalogue-photo.entity';
import { RegulatoryEvaluationResultEntity } from '../entities/regulatory-evaluation.entity';
import { CatalogueItemWithDetails } from '../repositories/seafood-catalogue.repository';
import { RegulatoryEligibilityService } from '../services/regulatory-eligibility.service';
import { SeafoodCatalogueService } from '../services/seafood-catalogue.service';

@ApiTags('Seafood Catalogue')
@Controller('catalogue')
export class SeafoodCatalogueController {
  constructor(
    private readonly catalogueService: SeafoodCatalogueService,
    private readonly regulatoryService: RegulatoryEligibilityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Browse published seafood master catalogue items' })
  async browse(@Query() query: QueryCatalogueDto) {
    const result = await this.catalogueService.findMany(query, true);
    return {
      data: result.items.map((item) => this.toResponse(item)),
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Get('photos')
  @ApiOperation({
    summary:
      'Search approved species catalogue reference photos by speciesId or English/Jamaican/scientific term',
  })
  async browsePhotos(@Query() query: QueryCataloguePhotosDto): Promise<CataloguePhotoEntity[]> {
    const photos = await this.catalogueService.findApprovedPhotos(query);
    return photos.map((photo) => this.toPhotoEntity(photo));
  }

  @Get('photos/credits')
  @ApiOperation({
    summary:
      'List public attribution and licensing metadata for published and actively-referenced catalogue photos',
  })
  async browsePhotoCredits(): Promise<CataloguePhotoEntity[]> {
    const photos = await this.catalogueService.findPublicPhotoCredits();
    return photos.map((photo) => this.toPhotoEntity(photo));
  }

  private toPhotoEntity(
    photo: Awaited<ReturnType<SeafoodCatalogueService['findApprovedPhotos']>>[number],
  ): CataloguePhotoEntity {
    return {
      id: photo.id,
      speciesId: photo.speciesId,
      catalogueItemId: photo.catalogueItemId,
      title: photo.title,
      scientificName: photo.scientificName,
      jamaicanAliases: photo.jamaicanAliases,
      imageUrl: photo.imageUrl,
      sourceName: photo.sourceName,
      sourceUrl: photo.sourceUrl,
      photographer: photo.photographer,
      licenseName: photo.licenseName,
      licenseUrl: photo.licenseUrl,
      modifications: photo.modifications,
      requiresAttribution: photo.requiresAttribution,
      approvalStatus: photo.approvalStatus,
      isDefault: photo.isDefault,
      versionGroupId: photo.versionGroupId,
      versionNumber: photo.versionNumber,
      retiredAt: photo.retiredAt ?? null,
      species: photo.species
        ? {
            id: photo.species.id,
            commercialName: photo.species.commercialName,
            scientificName: photo.species.scientificName,
            regulatoryStatus: photo.species.regulatoryStatus,
          }
        : undefined,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a published master catalogue item' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SeafoodCatalogueItemResponseEntity> {
    const item = await this.catalogueService.findById(id, true);
    return this.toResponse(item);
  }

  @Post('regulatory/evaluate')
  @ApiOperation({ summary: 'Evaluate regulatory eligibility for a catalogue item' })
  async evaluateRegulatory(
    @Body() dto: EvaluateRegulatoryEligibilityDto,
  ): Promise<RegulatoryEvaluationResultEntity> {
    return this.regulatoryService.evaluate({
      catalogueItemId: dto.catalogueItemId,
      vendorDailyListingId: dto.vendorDailyListingId,
      seafoodLotId: dto.seafoodLotId,
      atDate: dto.atDate,
    });
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
