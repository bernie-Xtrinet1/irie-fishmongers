import { Injectable } from '@nestjs/common';
import {
  CustomerAcceptanceStatus,
  Prisma,
  Review,
  ReviewModerationStatus,
  VendorOrderStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  CreateReviewAuditLogInput,
  ReviewAuditLogsRepository,
} from './review-audit-logs.repository';

export interface CreateReviewInput {
  authorId: string;
  vendorId: string;
  productId?: string;
  vendorOrderId: string;
  rating: number;
  title?: string;
  body: string;
}

export interface UpdateReviewInput {
  rating?: number;
  title?: string;
  body?: string;
}

export interface Page {
  skip: number;
  take: number;
}

// Exactly what the eligibility guard needs from a vendor order (Phase 13A).
// Read here via PrismaService directly rather than importing OrdersModule/
// DeliveryModule - that would create a ProductsModule -> ReviewsModule ->
// OrdersModule -> ProductsModule cycle once 13E wires product-detail
// ratings. A raw Prisma query against these tables isn't scoped by NestJS
// module boundaries, so it sidesteps the cycle entirely (same approach as
// SeafoodLotsRepository.findLatestInspectedAt).
export interface VendorOrderForEligibility {
  vendorId: string;
  status: VendorOrderStatus;
  order: { customerId: string };
  items: { productId: string }[];
  delivery: { deliveredAt: Date | null; customerAcceptanceStatus: CustomerAcceptanceStatus } | null;
}

// Public review rows carry the author's name parts (to derive a masked
// display name) and the product name - never the raw authorId/email.
const publicReview = Prisma.validator<Prisma.ReviewDefaultArgs>()({
  include: {
    author: { select: { firstName: true, lastName: true } },
    product: { select: { name: true } },
  },
});

export type PublicReview = Prisma.ReviewGetPayload<typeof publicReview>;

// Admin moderation rows carry everything the moderator queue needs: the
// author's name parts (for a masked label), the product name, and the
// joined delivery's customer-acceptance status so deliveryWasRejected can
// be computed at read time (Phase 13B step 5) rather than stored.
const adminReview = Prisma.validator<Prisma.ReviewDefaultArgs>()({
  include: {
    author: { select: { firstName: true, lastName: true } },
    product: { select: { name: true } },
    vendorOrder: { select: { delivery: { select: { customerAcceptanceStatus: true } } } },
  },
});

export type AdminReview = Prisma.ReviewGetPayload<typeof adminReview>;

export interface AdminReviewFilters {
  moderationStatus?: ReviewModerationStatus;
  vendorId?: string;
  productId?: string;
  rating?: number;
  deliveryWasRejected?: boolean;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface AdminRemoveInput {
  reviewId: string;
  actorId: string;
  reason: string;
  audit: CreateReviewAuditLogInput;
}

export interface RatingSummary {
  average: number | null;
  count: number;
}

@Injectable()
export class ReviewsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewAuditLogs: ReviewAuditLogsRepository,
  ) {}

  create(input: CreateReviewInput): Promise<Review> {
    return this.prisma.review.create({ data: input });
  }

  findById(id: string): Promise<Review | null> {
    return this.prisma.review.findUnique({ where: { id } });
  }

  findPublicById(id: string): Promise<PublicReview | null> {
    return this.prisma.review.findUnique({ where: { id }, include: publicReview.include });
  }

  update(id: string, input: UpdateReviewInput): Promise<Review> {
    return this.prisma.review.update({
      where: { id },
      data: { ...input, editedAt: new Date() },
    });
  }

  softDeleteByAuthor(id: string): Promise<Review> {
    return this.prisma.review.update({
      where: { id },
      data: { moderationStatus: 'REMOVED_BY_AUTHOR', removedAt: new Date() },
    });
  }

  restore(id: string): Promise<Review> {
    return this.prisma.review.update({
      where: { id },
      data: { moderationStatus: 'VISIBLE', removedAt: null, removedById: null, removalReason: null },
    });
  }

  findVendorOrderForEligibility(vendorOrderId: string): Promise<VendorOrderForEligibility | null> {
    return this.prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        vendorId: true,
        status: true,
        order: { select: { customerId: true } },
        items: { select: { productId: true } },
        delivery: { select: { deliveredAt: true, customerAcceptanceStatus: true } },
      },
    });
  }

  async listVisibleByVendor(
    vendorId: string,
    page: Page,
  ): Promise<{ items: PublicReview[]; total: number }> {
    const where: Prisma.ReviewWhereInput = { vendorId, moderationStatus: 'VISIBLE' };

    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: publicReview.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { items, total };
  }

  async listVisibleByProduct(
    productId: string,
    page: Page,
  ): Promise<{ items: PublicReview[]; total: number }> {
    const where: Prisma.ReviewWhereInput = { productId, moderationStatus: 'VISIBLE' };

    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: publicReview.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { items, total };
  }

  listRecentVisibleByVendor(vendorId: string, limit: number): Promise<PublicReview[]> {
    return this.prisma.review.findMany({
      where: { vendorId, moderationStatus: 'VISIBLE' },
      include: publicReview.include,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getVendorRatingSummary(vendorId: string): Promise<RatingSummary> {
    const result = await this.prisma.review.aggregate({
      where: { vendorId, moderationStatus: 'VISIBLE' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    return { average: result._avg.rating, count: result._count._all };
  }

  async getProductRatingSummary(productId: string): Promise<RatingSummary> {
    const result = await this.prisma.review.aggregate({
      where: { productId, moderationStatus: 'VISIBLE' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    return { average: result._avg.rating, count: result._count._all };
  }

  findAdminById(id: string): Promise<AdminReview | null> {
    return this.prisma.review.findUnique({ where: { id }, include: adminReview.include });
  }

  async listForAdmin(
    filters: AdminReviewFilters,
    page: Page,
  ): Promise<{ items: AdminReview[]; total: number }> {
    // deliveryWasRejected filters on the nested Delivery record: true means
    // the customer rejected it; false means everything else (accepted,
    // pending, or no delivery record at all).
    const rejectedFilter: Prisma.ReviewWhereInput | undefined =
      filters.deliveryWasRejected === undefined
        ? undefined
        : filters.deliveryWasRejected
          ? { vendorOrder: { delivery: { customerAcceptanceStatus: 'REJECTED' } } }
          : { NOT: { vendorOrder: { delivery: { customerAcceptanceStatus: 'REJECTED' } } } };

    const where: Prisma.ReviewWhereInput = {
      ...(filters.moderationStatus ? { moderationStatus: filters.moderationStatus } : {}),
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.rating ? { rating: filters.rating } : {}),
      ...(filters.createdAfter || filters.createdBefore
        ? {
            createdAt: {
              ...(filters.createdAfter ? { gte: filters.createdAfter } : {}),
              ...(filters.createdBefore ? { lte: filters.createdBefore } : {}),
            },
          }
        : {}),
      ...(rejectedFilter ?? {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: adminReview.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { items, total };
  }

  // The moderation update and its audit record commit together or not at
  // all: the audit row IS part of the moderation action's integrity, so a
  // failed audit write must leave the review VISIBLE (Phase 13B).
  async removeByAdmin(input: AdminRemoveInput): Promise<AdminReview> {
    const [updated] = await this.prisma.$transaction([
      this.prisma.review.update({
        where: { id: input.reviewId },
        data: {
          moderationStatus: 'REMOVED_BY_ADMIN',
          removedById: input.actorId,
          removalReason: input.reason,
          removedAt: new Date(),
        },
        include: adminReview.include,
      }),
      this.reviewAuditLogs.buildCreate(input.audit),
    ]);
    return updated;
  }
}
