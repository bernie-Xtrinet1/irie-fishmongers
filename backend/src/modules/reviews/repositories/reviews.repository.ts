import { Injectable } from '@nestjs/common';
import { CustomerAcceptanceStatus, Prisma, Review, VendorOrderStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

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

export interface RatingSummary {
  average: number | null;
  count: number;
}

@Injectable()
export class ReviewsRepository {
  constructor(private readonly prisma: PrismaService) {}

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
}
