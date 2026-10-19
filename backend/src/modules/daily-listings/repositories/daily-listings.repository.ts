import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CatalogueLifecycleStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Prisma,
  ProductUnit,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { DeclareListingSpeciesDto } from '../dto/declare-listing-species.dto';
import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';

export const listingIncludeDetails = (includeWithdrawnPhotos = false) =>
  Prisma.validator<Prisma.VendorDailyListingDefaultArgs>()({
    include: {
      photos: {
        where: includeWithdrawnPhotos ? undefined : { withdrawnAt: null },
        orderBy: [{ isPrimary: 'desc' }, { uploadedAt: 'asc' }],
      },
      speciesDeclarations: {
        include: {
          species: true,
        },
      },
      vendor: {
        select: {
          id: true,
          businessName: true,
          tier: true,
          parish: true,
        },
      },
      catalogueItem: {
        select: {
          id: true,
          name: true,
          commonName: true,
          categoryId: true,
          compositionMode: true,
          referenceImageUrl: true,
        },
      },
      lot: {
        select: {
          id: true,
          lotNumber: true,
          publicTraceToken: true,
          freshnessGrade: true,
          foodSafetyStatus: true,
          originType: true,
          acquisitionType: true,
        },
      },
      landingSite: {
        select: {
          id: true,
          name: true,
          parish: true,
        },
      },
      product: {
        select: {
          id: true,
          name: true,
          inventoryMode: true,
          quantityAvailable: true,
        },
      },
    },
  });

export type DailyListingWithDetails = Prisma.VendorDailyListingGetPayload<
  ReturnType<typeof listingIncludeDetails>
>;

export interface CreateListingData {
  vendorId: string;
  productId: string;
  catalogueItemId: string;
  lotId: string;
  landingSiteId?: string | null;
  listingTitle?: string | null;
  description?: string | null;
  catchDate: Date;
  availableFrom?: Date;
  expiresAt: Date;
  unit: ProductUnit;
  price: number;
  currency?: string;
  quantityUploaded: number;
  preparationOptions?: any;
  deliveryAvailable?: boolean;
  pickupAvailable?: boolean;
  status?: ListingLifecycleStatus;
}

export interface UpdateListingData {
  listingTitle?: string | null;
  description?: string | null;
  expiresAt?: Date;
  price?: number;
  quantityUploaded?: number;
  preparationOptions?: any;
  deliveryAvailable?: boolean;
  pickupAvailable?: boolean;
}

@Injectable()
export class DailyListingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    id: string,
    includeWithdrawnPhotos = false,
  ): Promise<DailyListingWithDetails | null> {
    return this.prisma.vendorDailyListing.findUnique({
      where: { id },
      include: listingIncludeDetails(includeWithdrawnPhotos).include,
    });
  }

  async findMany(filters: QueryDailyListingsDto): Promise<DailyListingWithDetails[]> {
    const where = this.buildWhereClause(filters);
    const pageSize = filters.pageSize ? Math.min(Math.max(filters.pageSize, 1), 100) : 20;
    const page = filters.page ? Math.max(filters.page, 1) : 1;
    const skip = (page - 1) * pageSize;

    return this.prisma.vendorDailyListing.findMany({
      where,
      include: listingIncludeDetails(false).include,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    });
  }

  async count(filters: QueryDailyListingsDto): Promise<number> {
    const where = this.buildWhereClause(filters);
    return this.prisma.vendorDailyListing.count({ where });
  }

  async create(
    data: CreateListingData,
    speciesDeclarations?: DeclareListingSpeciesDto[],
  ): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.vendorDailyListing.create({
        data: {
          vendorId: data.vendorId,
          productId: data.productId,
          catalogueItemId: data.catalogueItemId,
          lotId: data.lotId,
          landingSiteId: data.landingSiteId ?? null,
          listingTitle: data.listingTitle?.trim() || null,
          description: data.description?.trim() || null,
          catchDate: data.catchDate,
          availableFrom: data.availableFrom ?? new Date(),
          expiresAt: data.expiresAt,
          unit: data.unit,
          price: new Prisma.Decimal(data.price),
          currency: data.currency ?? 'JMD',
          quantityUploaded: new Prisma.Decimal(data.quantityUploaded),
          quantityAvailable: new Prisma.Decimal(data.quantityUploaded),
          quantityReserved: new Prisma.Decimal(0),
          quantitySold: new Prisma.Decimal(0),
          preparationOptions: data.preparationOptions ?? Prisma.DbNull,
          deliveryAvailable: data.deliveryAvailable ?? true,
          pickupAvailable: data.pickupAvailable ?? true,
          status: data.status ?? ListingLifecycleStatus.DRAFT,
        },
      });

      if (speciesDeclarations && speciesDeclarations.length > 0) {
        await tx.vendorDailyListingSpecies.createMany({
          data: speciesDeclarations.map((d) => ({
            vendorDailyListingId: created.id,
            speciesId: d.speciesId,
            proportion: d.proportion !== undefined ? new Prisma.Decimal(d.proportion) : null,
            notes: d.notes?.trim() || null,
          })),
        });
      }

      return tx.vendorDailyListing.findUniqueOrThrow({
        where: { id: created.id },
        include: listingIncludeDetails(false).include,
      });
    });
  }

  async update(
    id: string,
    data: UpdateListingData,
    speciesDeclarations?: DeclareListingSpeciesDto[],
  ): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.VendorDailyListingUpdateInput = {};

      if (data.listingTitle !== undefined) {
        updateData.listingTitle = data.listingTitle?.trim() || null;
      }
      if (data.description !== undefined) {
        updateData.description = data.description?.trim() || null;
      }
      if (data.expiresAt !== undefined) {
        updateData.expiresAt = data.expiresAt;
      }
      if (data.price !== undefined) {
        updateData.price = new Prisma.Decimal(data.price);
      }
      if (data.quantityUploaded !== undefined) {
        const qty = new Prisma.Decimal(data.quantityUploaded);
        updateData.quantityUploaded = qty;
        updateData.quantityAvailable = qty;
      }
      if (data.preparationOptions !== undefined) {
        updateData.preparationOptions = data.preparationOptions ?? Prisma.DbNull;
      }
      if (data.deliveryAvailable !== undefined) {
        updateData.deliveryAvailable = data.deliveryAvailable;
      }
      if (data.pickupAvailable !== undefined) {
        updateData.pickupAvailable = data.pickupAvailable;
      }

      await tx.vendorDailyListing.update({
        where: { id },
        data: updateData,
      });

      if (speciesDeclarations !== undefined) {
        await tx.vendorDailyListingSpecies.deleteMany({
          where: { vendorDailyListingId: id },
        });

        if (speciesDeclarations.length > 0) {
          await tx.vendorDailyListingSpecies.createMany({
            data: speciesDeclarations.map((d) => ({
              vendorDailyListingId: id,
              speciesId: d.speciesId,
              proportion: d.proportion !== undefined ? new Prisma.Decimal(d.proportion) : null,
              notes: d.notes?.trim() || null,
            })),
          });
        }
      }

      return tx.vendorDailyListing.findUniqueOrThrow({
        where: { id },
        include: listingIncludeDetails(false).include,
      });
    });
  }

  async addPhoto(
    listingId: string,
    photoData: {
      url: string;
      caption?: string;
      isPrimary?: boolean;
      captureDate?: Date;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const shouldBePrimary = photoData.isPrimary ?? false;

      if (shouldBePrimary) {
        // Demote existing primary active photos for this listing
        await tx.listingPhoto.updateMany({
          where: {
            vendorDailyListingId: listingId,
            isPrimary: true,
            withdrawnAt: null,
          },
          data: {
            isPrimary: false,
          },
        });
      } else {
        // If there are no existing active photos, this one automatically becomes primary
        const activeCount = await tx.listingPhoto.count({
          where: {
            vendorDailyListingId: listingId,
            withdrawnAt: null,
          },
        });
        if (activeCount === 0) {
          photoData.isPrimary = true;
        }
      }

      return tx.listingPhoto.create({
        data: {
          vendorDailyListingId: listingId,
          url: photoData.url.trim(),
          caption: photoData.caption?.trim() || null,
          isPrimary: photoData.isPrimary ?? false,
          moderationStatus: ListingPhotoModerationStatus.APPROVED,
          captureDate: photoData.captureDate ?? null,
        },
      });
    });
  }

  async withdrawPhoto(
    photoId: string,
    userId: string,
    reason: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const photo = await tx.listingPhoto.findUnique({
        where: { id: photoId },
      });
      if (!photo) {
        throw new NotFoundException(`Listing photo not found: ${photoId}`);
      }

      const listing = await tx.vendorDailyListing.findUnique({
        where: { id: photo.vendorDailyListingId },
        select: { id: true, status: true, productId: true },
      });

      // Mandatory locking order: products -> vendor_daily_listings
      if (listing) {
        if (listing.productId) {
          await tx.$queryRaw`SELECT id FROM products WHERE id = ${listing.productId} FOR UPDATE`;
        }
        await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${listing.id} FOR UPDATE`;
      }

      const updated = await tx.listingPhoto.update({
        where: { id: photoId },
        data: {
          withdrawnAt: new Date(),
          withdrawnByUserId: userId,
          withdrawnReason: reason.trim(),
          isPrimary: false,
        },
      });

      // If the withdrawn photo was primary, check if another active approved photo can be promoted
      if (photo.isPrimary) {
        const nextCandidate = await tx.listingPhoto.findFirst({
          where: {
            vendorDailyListingId: photo.vendorDailyListingId,
            withdrawnAt: null,
            moderationStatus: ListingPhotoModerationStatus.APPROVED,
          },
          orderBy: { uploadedAt: 'asc' },
        });

        if (nextCandidate) {
          await tx.listingPhoto.update({
            where: { id: nextCandidate.id },
            data: { isPrimary: true },
          });
        }
      }

      // Auto-withdraw governance: If listing was PUBLISHED, check if at least one approved active photo remains
      const remainingPhotosCount = await tx.listingPhoto.count({
        where: {
          vendorDailyListingId: photo.vendorDailyListingId,
          withdrawnAt: null,
          moderationStatus: ListingPhotoModerationStatus.APPROVED,
        },
      });

      if (remainingPhotosCount === 0 && listing && listing.status === ListingLifecycleStatus.PUBLISHED) {
        await tx.vendorDailyListing.update({
          where: { id: listing.id },
          data: {
            status: ListingLifecycleStatus.WITHDRAWN,
            withdrawnAt: new Date(),
            withdrawnReason: 'Automatically withdrawn: all listing photographs withdrawn',
          },
        });
        if (listing.productId) {
          await this.syncProductProjectionUnderLock(tx, listing.productId);
        }
      }

      return updated;
    });
  }

  async setPrimaryPhoto(listingId: string, photoId: string) {
    return this.prisma.$transaction(async (tx) => {
      const photo = await tx.listingPhoto.findUnique({
        where: { id: photoId },
      });
      if (!photo || photo.vendorDailyListingId !== listingId) {
        throw new NotFoundException('Photo not found on this listing');
      }
      if (photo.withdrawnAt !== null) {
        throw new BadRequestException('Cannot set withdrawn photo as primary');
      }
      if (photo.moderationStatus === ListingPhotoModerationStatus.REJECTED) {
        throw new BadRequestException('Cannot set rejected photo as primary');
      }

      await tx.listingPhoto.updateMany({
        where: {
          vendorDailyListingId: listingId,
          isPrimary: true,
          withdrawnAt: null,
        },
        data: { isPrimary: false },
      });

      return tx.listingPhoto.update({
        where: { id: photoId },
        data: { isPrimary: true },
      });
    });
  }

  async publishListing(
    id: string,
    regulatoryValidator?: (
      tx: Prisma.TransactionClient,
      listing: DailyListingWithDetails,
    ) => Promise<void>,
  ): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const preliminary = await tx.vendorDailyListing.findUnique({
        where: { id },
        select: { id: true, catalogueItemId: true, productId: true, lotId: true },
      });

      if (!preliminary) {
        throw new NotFoundException(`Listing not found: ${id}`);
      }

      // Enforce mandatory, deterministic row locking order across tables:
      // species -> seafood_catalogue_items -> regulatory_overrides -> products -> vendor_daily_listings -> seafood_lots
      if (preliminary.catalogueItemId) {
        await tx.$queryRaw`SELECT id FROM species WHERE id IN (SELECT "speciesId" FROM catalogue_item_species WHERE "catalogueItemId" = ${preliminary.catalogueItemId}) FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM seafood_catalogue_items WHERE id = ${preliminary.catalogueItemId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM regulatory_overrides WHERE "catalogueItemId" = ${preliminary.catalogueItemId} FOR UPDATE`;
      }
      if (preliminary.productId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${preliminary.productId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${id} FOR UPDATE`;
      if (preliminary.lotId) {
        await tx.$queryRaw`SELECT id FROM seafood_lots WHERE id = ${preliminary.lotId} FOR UPDATE`;
      }

      const current = await tx.vendorDailyListing.findUniqueOrThrow({
        where: { id },
        include: {
          catalogueItem: true,
          lot: true,
          photos: true,
        },
      });

      // Guard 1: Status must still be DRAFT
      if (current.status !== ListingLifecycleStatus.DRAFT) {
        throw new BadRequestException(
          `Cannot publish listing: current status is ${current.status}, expected DRAFT`,
        );
      }

      // Guard 2: Must not be expired
      if (new Date(current.expiresAt).getTime() <= Date.now()) {
        throw new BadRequestException('Cannot publish an already expired listing');
      }

      // Guard 3: Backing catalogue item must be in PUBLISHED status (not RETIRED, DRAFT, etc.)
      if (!current.catalogueItem || current.catalogueItem.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
        throw new BadRequestException(
          `Cannot publish listing: backing catalogue item is in ${current.catalogueItem?.lifecycleStatus ?? 'UNKNOWN'} status (must be PUBLISHED)`,
        );
      }

      // Guard 4: Backing seafood lot must have SAFE food safety status
      if (!current.lot || current.lot.foodSafetyStatus !== 'SAFE') {
        throw new BadRequestException(
          `Cannot publish listing: seafood lot food safety status is ${current.lot?.foodSafetyStatus ?? 'UNKNOWN'} (must be SAFE)`,
        );
      }

      // Guard 5: Photo governance - at least one approved non-withdrawn photograph
      const activePhotos = current.photos.filter(
        (p) => !p.withdrawnAt && p.moderationStatus === ListingPhotoModerationStatus.APPROVED,
      );
      if (activePhotos.length === 0) {
        throw new BadRequestException(
          'Listing must have at least one approved actual-catch photograph before publication',
        );
      }

      // Ensure a primary photo is designated
      const hasPrimary = activePhotos.some((p) => p.isPrimary);
      if (!hasPrimary && activePhotos[0]) {
        await tx.listingPhoto.update({
          where: { id: activePhotos[0].id },
          data: { isPrimary: true },
        });
      }

      // In-transaction regulatory validator under locks
      if (regulatoryValidator) {
        const fullListing = await tx.vendorDailyListing.findUniqueOrThrow({
          where: { id },
          include: listingIncludeDetails(false).include,
        });
        await regulatoryValidator(tx, fullListing);
      }

      const published = await tx.vendorDailyListing.update({
        where: { id },
        data: {
          status: ListingLifecycleStatus.PUBLISHED,
          publishedAt: new Date(),
        },
        include: listingIncludeDetails(false).include,
      });

      if (preliminary.productId) {
        await this.syncProductProjectionUnderLock(tx, preliminary.productId);
      }

      return published;
    });
  }

  async withdrawListing(id: string, reason: string): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const preliminary = await tx.vendorDailyListing.findUnique({
        where: { id },
        select: { id: true, productId: true },
      });

      if (!preliminary) {
        throw new NotFoundException(`Listing not found: ${id}`);
      }

      // Enforce mandatory row locking order: products -> vendor_daily_listings
      if (preliminary.productId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${preliminary.productId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${id} FOR UPDATE`;

      const withdrawn = await tx.vendorDailyListing.update({
        where: { id },
        data: {
          status: ListingLifecycleStatus.WITHDRAWN,
          withdrawnAt: new Date(),
          withdrawnReason: reason.trim(),
        },
        include: listingIncludeDetails(false).include,
      });

      if (preliminary.productId) {
        await this.syncProductProjectionUnderLock(tx, preliminary.productId);
      }

      return withdrawn;
    });
  }

  async suspendListing(id: string, reason: string): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const preliminary = await tx.vendorDailyListing.findUnique({
        where: { id },
        select: { id: true, productId: true },
      });

      if (!preliminary) {
        throw new NotFoundException(`Listing not found: ${id}`);
      }

      // Enforce mandatory row locking order: products -> vendor_daily_listings
      if (preliminary.productId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${preliminary.productId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${id} FOR UPDATE`;

      const suspended = await tx.vendorDailyListing.update({
        where: { id },
        data: {
          status: ListingLifecycleStatus.SUSPENDED,
          suspendedAt: new Date(),
          suspensionReason: reason.trim(),
        },
        include: listingIncludeDetails(false).include,
      });

      if (preliminary.productId) {
        await this.syncProductProjectionUnderLock(tx, preliminary.productId);
      }

      return suspended;
    });
  }

  async reinstateListing(
    id: string,
    regulatoryValidator?: (
      tx: Prisma.TransactionClient,
      listing: DailyListingWithDetails,
    ) => Promise<void>,
  ): Promise<DailyListingWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const preliminary = await tx.vendorDailyListing.findUnique({
        where: { id },
        select: { id: true, catalogueItemId: true, productId: true, lotId: true },
      });

      if (!preliminary) {
        throw new NotFoundException(`Listing not found: ${id}`);
      }

      // Enforce mandatory, deterministic row locking order:
      // species -> seafood_catalogue_items -> regulatory_overrides -> products -> vendor_daily_listings -> seafood_lots
      if (preliminary.catalogueItemId) {
        await tx.$queryRaw`SELECT id FROM species WHERE id IN (SELECT "speciesId" FROM catalogue_item_species WHERE "catalogueItemId" = ${preliminary.catalogueItemId}) FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM seafood_catalogue_items WHERE id = ${preliminary.catalogueItemId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM regulatory_overrides WHERE "catalogueItemId" = ${preliminary.catalogueItemId} FOR UPDATE`;
      }
      if (preliminary.productId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${preliminary.productId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${id} FOR UPDATE`;
      if (preliminary.lotId) {
        await tx.$queryRaw`SELECT id FROM seafood_lots WHERE id = ${preliminary.lotId} FOR UPDATE`;
      }

      const current = await tx.vendorDailyListing.findUniqueOrThrow({
        where: { id },
        include: listingIncludeDetails(false).include,
      });

      if (current.status !== ListingLifecycleStatus.SUSPENDED) {
        throw new BadRequestException('Only suspended listings can be reinstated');
      }

      if (regulatoryValidator) {
        await regulatoryValidator(tx, current);
      }

      const reinstated = await tx.vendorDailyListing.update({
        where: { id },
        data: {
          status: ListingLifecycleStatus.PUBLISHED,
          suspendedAt: null,
          suspensionReason: null,
        },
        include: listingIncludeDetails(false).include,
      });

      if (preliminary.productId) {
        await this.syncProductProjectionUnderLock(tx, preliminary.productId);
      }

      return reinstated;
    });
  }

  async updateQuantities(
    listingId: string,
    deltas: {
      availableDelta?: number;
      reservedDelta?: number;
      soldDelta?: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const preliminary = await tx.vendorDailyListing.findUnique({
        where: { id: listingId },
        select: { id: true, productId: true },
      });

      if (!preliminary) {
        throw new NotFoundException(`Listing not found: ${listingId}`);
      }

      // Enforce mandatory row locking order: products -> vendor_daily_listings
      if (preliminary.productId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${preliminary.productId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${listingId} FOR UPDATE`;

      const data: Prisma.VendorDailyListingUpdateInput = {};

      if (deltas.availableDelta !== undefined) {
        data.quantityAvailable = { increment: new Prisma.Decimal(deltas.availableDelta) };
      }
      if (deltas.reservedDelta !== undefined) {
        data.quantityReserved = { increment: new Prisma.Decimal(deltas.reservedDelta) };
      }
      if (deltas.soldDelta !== undefined) {
        data.quantitySold = { increment: new Prisma.Decimal(deltas.soldDelta) };
      }

      const updated = await tx.vendorDailyListing.update({
        where: { id: listingId },
        data,
      });

      if (preliminary.productId) {
        await this.syncProductProjectionUnderLock(tx, preliminary.productId);
      }

      return updated;
    });
  }

  async syncProductProjectionUnderLock(
    tx: Prisma.TransactionClient,
    productId: string,
    now: Date = new Date(),
  ): Promise<void> {
    // Mandatory product lock: fail closed if lock cannot be acquired
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;

    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, inventoryMode: true },
    });

    // Guard: Only update projection if inventoryMode is LISTING_BACKED.
    // LEGACY_PRODUCT inventory is authoritative and must NEVER be overwritten.
    if (!product || product.inventoryMode !== 'LISTING_BACKED') {
      return;
    }

    const activePublishedListings = await tx.vendorDailyListing.findMany({
      where: {
        productId,
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: { gt: now },
        availableFrom: { lte: now },
        quantityAvailable: { gt: 0 },
      },
      select: {
        quantityAvailable: true,
      },
    });

    const sumDurable = activePublishedListings.reduce(
      (acc, curr) => acc + Number(curr.quantityAvailable),
      0,
    );

    await tx.product.updateMany({
      where: {
        id: productId,
        inventoryMode: 'LISTING_BACKED',
      },
      data: {
        quantityAvailable: Math.max(0, Math.floor(sumDurable)),
      },
    });
  }

  async findActiveByCatalogueItemId(catalogueItemId: string): Promise<DailyListingWithDetails[]> {
    const now = new Date();
    return this.prisma.vendorDailyListing.findMany({
      where: {
        catalogueItemId,
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: { gt: now },
        availableFrom: { lte: now },
        quantityAvailable: { gt: 0 },
      },
      include: listingIncludeDetails(false).include,
      orderBy: { price: 'asc' },
    });
  }

  private buildWhereClause(filters: QueryDailyListingsDto): Prisma.VendorDailyListingWhereInput {
    const where: Prisma.VendorDailyListingWhereInput = {};

    if (filters.vendorId) {
      where.vendorId = filters.vendorId;
    }
    if (filters.catalogueItemId) {
      where.catalogueItemId = filters.catalogueItemId;
    }

    if (filters.activeOnly) {
      const now = new Date();
      where.status = ListingLifecycleStatus.PUBLISHED;
      where.expiresAt = { gt: now };
      where.availableFrom = { lte: now };
      where.quantityAvailable = { gt: 0 };
    } else if (filters.status) {
      where.status = filters.status;
    }

    if (filters.search) {
      where.OR = [
        { listingTitle: { contains: filters.search.trim(), mode: 'insensitive' } },
        { description: { contains: filters.search.trim(), mode: 'insensitive' } },
      ];
    }

    return where;
  }
}
