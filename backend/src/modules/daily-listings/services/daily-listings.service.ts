import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMode,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { RegulatoryEligibilityService } from '../../catalogue/services/regulatory-eligibility.service';
import { SeafoodCatalogueRepository } from '../../catalogue/repositories/seafood-catalogue.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorDocumentsService } from '../../vendor-tiers/services/vendor-documents.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { AddListingPhotoDto } from '../dto/add-listing-photo.dto';
import { CreateDailyListingDto } from '../dto/create-daily-listing.dto';
import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';
import { RepeatDailyListingDto } from '../dto/repeat-daily-listing.dto';
import { SuspendDailyListingDto } from '../dto/suspend-daily-listing.dto';
import { UpdateDailyListingDto } from '../dto/update-daily-listing.dto';
import { WithdrawDailyListingDto } from '../dto/withdraw-daily-listing.dto';
import { WithdrawListingPhotoDto } from '../dto/withdraw-listing-photo.dto';
import { DailyListingResponseEntity } from '../entities/daily-listing-response.entity';
import { ListingPhotoResponseEntity } from '../entities/listing-photo-response.entity';
import { PaginatedDailyListingsEntity } from '../entities/paginated-daily-listings.entity';
import {
  DailyListingWithDetails,
  DailyListingsRepository,
} from '../repositories/daily-listings.repository';

@Injectable()
export class DailyListingsService {
  constructor(
    private readonly dailyListingsRepository: DailyListingsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly vendorDocumentsService: VendorDocumentsService,
    private readonly catalogueRepository: SeafoodCatalogueRepository,
    private readonly seafoodLotsRepository: SeafoodLotsRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly regulatoryEligibilityService: RegulatoryEligibilityService,
    private readonly prisma: PrismaService,
  ) {}

  async create(userId: string, dto: CreateDailyListingDto): Promise<DailyListingResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors may create daily seafood listings');
    }
    await this.vendorDocumentsService.assertCanSell(vendor.id, vendor.tier);

    // Master catalogue item check
    const catalogueItem = await this.catalogueRepository.findById(dto.catalogueItemId);
    if (!catalogueItem) {
      throw new NotFoundException(`Catalogue item not found: ${dto.catalogueItemId}`);
    }
    if (catalogueItem.lifecycleStatus !== 'PUBLISHED') {
      throw new BadRequestException('Master catalogue item must be PUBLISHED for commercial listing');
    }

    // Traceable SeafoodLot batch provenance check
    const lot = await this.seafoodLotsRepository.findById(dto.lotId);
    if (!lot) {
      throw new NotFoundException(`Seafood lot not found: ${dto.lotId}`);
    }
    if (lot.vendorId !== vendor.id) {
      throw new ForbiddenException('Seafood lot does not belong to your vendor account');
    }
    if (lot.foodSafetyStatus !== 'SAFE') {
      throw new BadRequestException(`Seafood lot food safety status is ${lot.foodSafetyStatus}; only SAFE lots may be listed`);
    }

    // Variable composite catalogue items require listing-level species declarations
    if (
      catalogueItem.compositionMode === 'VARIABLE_COMPOSITE' &&
      (!dto.speciesDeclarations || dto.speciesDeclarations.length === 0)
    ) {
      throw new BadRequestException(
        'VARIABLE_COMPOSITE catalogue items require at least one listing-level species declaration',
      );
    }

    // Catch date and expiration validation
    const catchDate = new Date(dto.catchDate);
    const now = new Date();
    if (catchDate.getTime() > now.getTime() + 60_000) {
      throw new BadRequestException('Catch date cannot be in the future');
    }

    const availableFrom = dto.availableFrom ? new Date(dto.availableFrom) : now;
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt.getTime() <= availableFrom.getTime()) {
      throw new BadRequestException('expiresAt must be after availableFrom');
    }

    // Resolve or anchor backing Product
    let productId = dto.productId;
    if (productId) {
      const product = await this.productsRepository.findById(productId);
      if (!product) {
        throw new NotFoundException(`Backing product not found: ${productId}`);
      }
      if (product.vendorId !== vendor.id) {
        throw new ForbiddenException('Backing product does not belong to your vendor account');
      }
      if (product.catalogueItemId && product.catalogueItemId !== catalogueItem.id) {
        throw new BadRequestException('Backing product is linked to a different master catalogue item');
      }
      if (!product.catalogueItemId) {
        await this.productsRepository.update(product.id, { catalogueItemId: catalogueItem.id });
      }
    } else {
      // Find existing product for this vendor and catalogue item, or create one
      const existingProduct = await this.prisma.product.findFirst({
        where: {
          vendorId: vendor.id,
          catalogueItemId: catalogueItem.id,
        },
      });

      if (existingProduct) {
        productId = existingProduct.id;
      } else {
        const createdProduct = await this.prisma.product.create({
          data: {
            vendorId: vendor.id,
            categoryId: catalogueItem.categoryId,
            catalogueItemId: catalogueItem.id,
            lotId: lot.id,
            name: dto.listingTitle?.trim() || catalogueItem.name,
            description: dto.description?.trim() || catalogueItem.description || catalogueItem.name,
            unit: dto.unit,
            price: new Prisma.Decimal(dto.price),
            currency: dto.currency || 'JMD',
            quantityAvailable: 0,
            imageUrl: catalogueItem.referenceImageUrl || '',
            isActive: true,
            inventoryMode: 'LEGACY_PRODUCT',
          },
        });
        productId = createdProduct.id;
      }
    }

    // Landing site validation if provided
    let landingSiteId = dto.landingSiteId ?? null;
    if (landingSiteId) {
      const site = await this.prisma.landingSite.findUnique({
        where: { id: landingSiteId },
      });
      if (!site) {
        throw new NotFoundException(`Landing site not found: ${landingSiteId}`);
      }
    }

    const listing = await this.dailyListingsRepository.create(
      {
        vendorId: vendor.id,
        productId,
        catalogueItemId: catalogueItem.id,
        lotId: lot.id,
        landingSiteId,
        listingTitle: dto.listingTitle,
        description: dto.description,
        catchDate,
        availableFrom,
        expiresAt,
        unit: dto.unit,
        price: dto.price,
        currency: dto.currency,
        quantityUploaded: dto.quantityUploaded,
        preparationOptions: dto.preparationOptions,
        deliveryAvailable: dto.deliveryAvailable,
        pickupAvailable: dto.pickupAvailable,
      },
      dto.speciesDeclarations,
    );

    return this.mapToEntity(listing);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    const listing = await this.assertOwnership(userId, id);

    if (
      listing.status === ListingLifecycleStatus.WITHDRAWN ||
      listing.status === ListingLifecycleStatus.SUSPENDED
    ) {
      throw new BadRequestException('Cannot modify a withdrawn or suspended listing');
    }

    if (
      listing.status === ListingLifecycleStatus.PUBLISHED &&
      dto.quantityUploaded !== undefined
    ) {
      throw new BadRequestException(
        'quantityUploaded cannot be modified after listing publication; adjust stock via sales or inventory adjustments',
      );
    }

    let expiresAt: Date | undefined;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (expiresAt.getTime() <= new Date(listing.availableFrom).getTime()) {
        throw new BadRequestException('expiresAt must be after availableFrom');
      }
    }

    const updated = await this.dailyListingsRepository.update(
      id,
      {
        listingTitle: dto.listingTitle,
        description: dto.description,
        expiresAt,
        price: dto.price,
        quantityUploaded: dto.quantityUploaded,
        preparationOptions: dto.preparationOptions,
        deliveryAvailable: dto.deliveryAvailable,
        pickupAvailable: dto.pickupAvailable,
      },
      dto.speciesDeclarations,
    );

    return this.mapToEntity(updated);
  }

  async publish(userId: string, id: string): Promise<DailyListingResponseEntity> {
    const listing = await this.assertOwnership(userId, id);

    if (listing.status !== ListingLifecycleStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT listings can be published; current status is ${listing.status}`,
      );
    }

    if (new Date(listing.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Cannot publish an already expired listing');
    }

    // Photo governance check: at least one approved non-withdrawn photo
    const activePhotos = listing.photos.filter(
      (p) => !p.withdrawnAt && p.moderationStatus === ListingPhotoModerationStatus.APPROVED,
    );
    if (activePhotos.length === 0) {
      throw new BadRequestException(
        'Listing must have at least one approved actual-catch photograph before publication',
      );
    }

    const primaryPhoto = activePhotos.find((p) => p.isPrimary);
    if (!primaryPhoto) {
      const firstPhoto = activePhotos[0];
      if (firstPhoto) {
        // Designate first approved active photo as primary if none explicitly designated
        await this.dailyListingsRepository.setPrimaryPhoto(listing.id, firstPhoto.id);
      }
    }

    // Pre-publication regulatory gate
    const preEvaluation = await this.regulatoryEligibilityService.evaluate({
      catalogueItemId: listing.catalogueItemId,
      vendorDailyListingId: listing.id,
      seafoodLotId: listing.lotId,
      atDate: new Date(),
    });

    if (!preEvaluation.eligible) {
      throw new BadRequestException(
        `Publication rejected due to regulatory restriction: ${preEvaluation.reasons.join('; ')}`,
      );
    }

    const published = await this.dailyListingsRepository.publishListing(
      id,
      async (tx, lockedListing) => {
        const evaluation = await this.regulatoryEligibilityService.evaluate({
          catalogueItemId: lockedListing.catalogueItemId,
          vendorDailyListingId: lockedListing.id,
          seafoodLotId: lockedListing.lotId,
          atDate: new Date(),
          tx,
        });

        if (!evaluation.eligible) {
          throw new BadRequestException(
            `Publication rejected due to regulatory restriction: ${evaluation.reasons.join('; ')}`,
          );
        }
      },
    );

    return this.mapToEntity(published);
  }

  async withdraw(
    userId: string,
    id: string,
    dto: WithdrawDailyListingDto,
    isAdmin = false,
  ): Promise<DailyListingResponseEntity> {
    const listing = isAdmin
      ? await this.dailyListingsRepository.findById(id)
      : await this.assertOwnership(userId, id);

    if (!listing) {
      throw new NotFoundException(`Listing not found: ${id}`);
    }

    if (listing.status === ListingLifecycleStatus.WITHDRAWN) {
      return this.mapToEntity(listing);
    }

    const withdrawn = await this.dailyListingsRepository.withdrawListing(id, dto.reason);

    return this.mapToEntity(withdrawn);
  }

  async suspend(
    adminUserId: string,
    id: string,
    dto: SuspendDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    const listing = await this.dailyListingsRepository.findById(id);
    if (!listing) {
      throw new NotFoundException(`Listing not found: ${id}`);
    }

    const suspended = await this.dailyListingsRepository.suspendListing(id, dto.reason);

    return this.mapToEntity(suspended);
  }

  async reinstate(
    adminUserId: string,
    id: string,
  ): Promise<DailyListingResponseEntity> {
    const listing = await this.dailyListingsRepository.findById(id);
    if (!listing) {
      throw new NotFoundException(`Listing not found: ${id}`);
    }
    if (listing.status !== ListingLifecycleStatus.SUSPENDED) {
      throw new BadRequestException('Only suspended listings can be reinstated');
    }

    // Re-evaluate regulatory compliance before reinstating
    const preEvaluation = await this.regulatoryEligibilityService.evaluate({
      catalogueItemId: listing.catalogueItemId,
      vendorDailyListingId: listing.id,
      seafoodLotId: listing.lotId,
      atDate: new Date(),
    });

    if (!preEvaluation.eligible) {
      throw new BadRequestException(
        `Cannot reinstate listing: regulatory restrictions still apply: ${preEvaluation.reasons.join('; ')}`,
      );
    }

    const reinstated = await this.dailyListingsRepository.reinstateListing(
      id,
      async (tx, lockedListing) => {
        const evaluation = await this.regulatoryEligibilityService.evaluate({
          catalogueItemId: lockedListing.catalogueItemId,
          vendorDailyListingId: lockedListing.id,
          seafoodLotId: lockedListing.lotId,
          atDate: new Date(),
          tx,
        });

        if (!evaluation.eligible) {
          throw new BadRequestException(
            `Cannot reinstate listing: regulatory restrictions still apply: ${evaluation.reasons.join('; ')}`,
          );
        }
      },
    );

    return this.mapToEntity(reinstated);
  }

  async repeat(
    userId: string,
    id: string,
    dto: RepeatDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    const previous = await this.assertOwnership(userId, id);
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }

    // Validate new lot
    const newLot = await this.seafoodLotsRepository.findById(dto.lotId);
    if (!newLot) {
      throw new NotFoundException(`Fresh seafood lot not found: ${dto.lotId}`);
    }
    if (newLot.vendorId !== vendor.id) {
      throw new ForbiddenException('Fresh seafood lot does not belong to your vendor account');
    }
    if (newLot.foodSafetyStatus !== 'SAFE') {
      throw new BadRequestException(`Fresh seafood lot food safety status is ${newLot.foodSafetyStatus}`);
    }

    const catchDate = new Date(dto.catchDate);
    const expiresAt = new Date(dto.expiresAt);
    if (catchDate.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('Catch date cannot be in the future');
    }
    if (expiresAt.getTime() <= catchDate.getTime()) {
      throw new BadRequestException('expiresAt must be after catchDate');
    }

    // Repeat produces a genuinely new, independent listing record copying static fields
    // and starting in DRAFT without carrying over photos (photos must be fresh per requirement E).
    const newListing = await this.dailyListingsRepository.create(
      {
        vendorId: vendor.id,
        productId: previous.productId,
        catalogueItemId: previous.catalogueItemId,
        lotId: newLot.id,
        landingSiteId: dto.landingSiteId ?? previous.landingSiteId,
        listingTitle: dto.listingTitle ?? previous.listingTitle,
        description: dto.description ?? previous.description,
        catchDate,
        availableFrom: new Date(),
        expiresAt,
        unit: previous.unit,
        price: dto.price,
        currency: previous.currency,
        quantityUploaded: dto.quantityUploaded,
        preparationOptions: previous.preparationOptions,
        deliveryAvailable: previous.deliveryAvailable,
        pickupAvailable: previous.pickupAvailable,
        status: ListingLifecycleStatus.DRAFT,
      },
      previous.speciesDeclarations.map((d) => ({
        speciesId: d.speciesId,
        proportion: d.proportion ? Number(d.proportion) : undefined,
        notes: d.notes || undefined,
      })),
    );

    return this.mapToEntity(newListing);
  }

  async addPhoto(
    userId: string,
    listingId: string,
    dto: AddListingPhotoDto,
  ): Promise<ListingPhotoResponseEntity> {
    await this.assertOwnership(userId, listingId);

    const captureDate = dto.captureDate ? new Date(dto.captureDate) : undefined;
    const photo = await this.dailyListingsRepository.addPhoto(listingId, {
      url: dto.url,
      caption: dto.caption,
      isPrimary: dto.isPrimary,
      captureDate,
    });

    return {
      id: photo.id,
      vendorDailyListingId: photo.vendorDailyListingId,
      url: photo.url,
      caption: photo.caption,
      isPrimary: photo.isPrimary,
      moderationStatus: photo.moderationStatus,
      uploadedAt: photo.uploadedAt,
      captureDate: photo.captureDate,
      withdrawnAt: photo.withdrawnAt,
      withdrawnReason: photo.withdrawnReason,
      createdAt: photo.createdAt,
      updatedAt: photo.updatedAt,
    };
  }

  async withdrawPhoto(
    userId: string,
    listingId: string,
    photoId: string,
    dto: WithdrawListingPhotoDto,
    isAdmin = false,
  ): Promise<ListingPhotoResponseEntity> {
    const listing = isAdmin
      ? await this.dailyListingsRepository.findById(listingId)
      : await this.assertOwnership(userId, listingId);

    if (!listing) {
      throw new NotFoundException(`Listing not found: ${listingId}`);
    }

    const photo = await this.dailyListingsRepository.withdrawPhoto(
      photoId,
      userId,
      dto.reason,
    );

    // If listing was PUBLISHED, check if at least one approved active photo remains
    if (listing.status === ListingLifecycleStatus.PUBLISHED) {
      const remainingPhotos = await this.prisma.listingPhoto.count({
        where: {
          vendorDailyListingId: listingId,
          withdrawnAt: null,
          moderationStatus: ListingPhotoModerationStatus.APPROVED,
        },
      });

      if (remainingPhotos === 0) {
        // Cannot remain published without an approved non-withdrawn photograph
        await this.dailyListingsRepository.withdrawListing(
          listingId,
          'Automatically withdrawn: all listing photographs withdrawn',
        );
      }
    }

    return {
      id: photo.id,
      vendorDailyListingId: photo.vendorDailyListingId,
      url: photo.url,
      caption: photo.caption,
      isPrimary: photo.isPrimary,
      moderationStatus: photo.moderationStatus,
      uploadedAt: photo.uploadedAt,
      captureDate: photo.captureDate,
      withdrawnAt: photo.withdrawnAt,
      withdrawnReason: photo.withdrawnReason,
      createdAt: photo.createdAt,
      updatedAt: photo.updatedAt,
    };
  }

  async setPrimaryPhoto(
    userId: string,
    listingId: string,
    photoId: string,
  ): Promise<ListingPhotoResponseEntity> {
    await this.assertOwnership(userId, listingId);
    const photo = await this.dailyListingsRepository.setPrimaryPhoto(listingId, photoId);

    return {
      id: photo.id,
      vendorDailyListingId: photo.vendorDailyListingId,
      url: photo.url,
      caption: photo.caption,
      isPrimary: photo.isPrimary,
      moderationStatus: photo.moderationStatus,
      uploadedAt: photo.uploadedAt,
      captureDate: photo.captureDate,
      withdrawnAt: photo.withdrawnAt,
      withdrawnReason: photo.withdrawnReason,
      createdAt: photo.createdAt,
      updatedAt: photo.updatedAt,
    };
  }

  async findById(id: string, includeWithdrawnPhotos = false): Promise<DailyListingResponseEntity> {
    const listing = await this.dailyListingsRepository.findById(id, includeWithdrawnPhotos);
    if (!listing) {
      throw new NotFoundException(`Listing not found: ${id}`);
    }
    return this.mapToEntity(listing);
  }

  async findMany(filters: QueryDailyListingsDto): Promise<PaginatedDailyListingsEntity> {
    const [items, total] = await Promise.all([
      this.dailyListingsRepository.findMany(filters),
      this.dailyListingsRepository.count(filters),
    ]);

    const limit = filters.pageSize ? Math.min(Math.max(filters.pageSize, 1), 100) : 20;
    const page = filters.page ? Math.max(filters.page, 1) : 1;

    return {
      items: items.map((i) => this.mapToEntity(i)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findMyListings(
    userId: string,
    query: QueryDailyListingsDto,
  ): Promise<PaginatedDailyListingsEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found for this account');
    }
    return this.findMany({
      ...query,
      vendorId: vendor.id,
    });
  }

  async findActiveByCatalogueItemId(
    catalogueItemId: string,
  ): Promise<DailyListingResponseEntity[]> {
    const listings = await this.dailyListingsRepository.findActiveByCatalogueItemId(catalogueItemId);
    return listings.map((l) => this.mapToEntity(l));
  }

  computeDerivedStatus(listing: {
    status: ListingLifecycleStatus;
    expiresAt: Date;
    quantityAvailable: Prisma.Decimal | number;
  }): string {
    if (listing.status === ListingLifecycleStatus.PUBLISHED) {
      if (new Date(listing.expiresAt).getTime() <= Date.now()) {
        return 'EXPIRED';
      }
      if (Number(listing.quantityAvailable) <= 0) {
        return 'SOLD_OUT';
      }
      return 'PUBLISHED';
    }
    return listing.status;
  }

  private async assertOwnership(
    userId: string,
    listingId: string,
  ): Promise<DailyListingWithDetails> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found for this account');
    }

    const listing = await this.dailyListingsRepository.findById(listingId, true);
    if (!listing) {
      throw new NotFoundException(`Listing not found: ${listingId}`);
    }

    if (listing.vendorId !== vendor.id) {
      throw new ForbiddenException('You do not own this daily seafood listing');
    }

    return listing;
  }

  async refreshProductQuantityProjection(productId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.dailyListingsRepository.syncProductProjectionUnderLock(tx, productId);
    });
  }

  private mapToEntity(listing: DailyListingWithDetails): DailyListingResponseEntity {
    const primaryPhoto = listing.photos.find((p) => p.isPrimary && !p.withdrawnAt) || null;

    return {
      id: listing.id,
      vendorId: listing.vendorId,
      productId: listing.productId,
      catalogueItemId: listing.catalogueItemId,
      lotId: listing.lotId,
      landingSiteId: listing.landingSiteId,
      listingTitle: listing.listingTitle,
      description: listing.description,
      catchDate: listing.catchDate,
      availableFrom: listing.availableFrom,
      expiresAt: listing.expiresAt,
      unit: listing.unit,
      price: Number(listing.price),
      currency: listing.currency,
      quantityUploaded: Number(listing.quantityUploaded),
      quantityAvailable: Number(listing.quantityAvailable),
      quantityReserved: Number(listing.quantityReserved),
      quantitySold: Number(listing.quantitySold),
      preparationOptions: listing.preparationOptions,
      deliveryAvailable: listing.deliveryAvailable,
      pickupAvailable: listing.pickupAvailable,
      status: listing.status,
      derivedStatus: this.computeDerivedStatus(listing),
      publishedAt: listing.publishedAt,
      withdrawnAt: listing.withdrawnAt,
      withdrawnReason: listing.withdrawnReason,
      suspendedAt: listing.suspendedAt,
      suspensionReason: listing.suspensionReason,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      primaryPhoto: primaryPhoto
        ? {
            id: primaryPhoto.id,
            vendorDailyListingId: primaryPhoto.vendorDailyListingId,
            url: primaryPhoto.url,
            caption: primaryPhoto.caption,
            isPrimary: primaryPhoto.isPrimary,
            moderationStatus: primaryPhoto.moderationStatus,
            uploadedAt: primaryPhoto.uploadedAt,
            captureDate: primaryPhoto.captureDate,
            withdrawnAt: primaryPhoto.withdrawnAt,
            withdrawnReason: primaryPhoto.withdrawnReason,
            createdAt: primaryPhoto.createdAt,
            updatedAt: primaryPhoto.updatedAt,
          }
        : null,
      photos: listing.photos.map((p) => ({
        id: p.id,
        vendorDailyListingId: p.vendorDailyListingId,
        url: p.url,
        caption: p.caption,
        isPrimary: p.isPrimary,
        moderationStatus: p.moderationStatus,
        uploadedAt: p.uploadedAt,
        captureDate: p.captureDate,
        withdrawnAt: p.withdrawnAt,
        withdrawnReason: p.withdrawnReason,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      speciesDeclarations: listing.speciesDeclarations.map((d) => ({
        id: d.id,
        vendorDailyListingId: d.vendorDailyListingId,
        speciesId: d.speciesId,
        proportion: d.proportion ? Number(d.proportion) : null,
        notes: d.notes,
        scientificName: d.species?.scientificName,
        commercialName: d.species?.commercialName,
        createdAt: d.createdAt,
      })),
      vendor: listing.vendor,
      catalogueItem: listing.catalogueItem,
      lot: listing.lot,
      landingSite: listing.landingSite,
    };
  }
}
