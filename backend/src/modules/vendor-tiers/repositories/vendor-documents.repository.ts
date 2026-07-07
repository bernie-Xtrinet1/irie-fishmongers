import { Injectable } from '@nestjs/common';
import { DocumentReviewStatus, VendorDocument, VendorDocumentType } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateVendorDocumentInput {
  vendorId: string;
  documentType: VendorDocumentType;
  fileUrl: string;
  documentNumber?: string;
  issuedDate?: Date;
  expiryDate?: Date;
}

export interface UpdateDocumentStatusInput {
  rejectionReason?: string;
  verifiedById?: string;
  verifiedAt?: Date;
}

@Injectable()
export class VendorDocumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateVendorDocumentInput): Promise<VendorDocument> {
    return this.prisma.vendorDocument.create({ data: input });
  }

  findById(id: string): Promise<VendorDocument | null> {
    return this.prisma.vendorDocument.findUnique({ where: { id } });
  }

  findByVendorId(vendorId: string): Promise<VendorDocument[]> {
    return this.prisma.vendorDocument.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
    });
  }

  updateStatus(
    id: string,
    status: DocumentReviewStatus,
    data: UpdateDocumentStatusInput = {},
  ): Promise<VendorDocument> {
    return this.prisma.vendorDocument.update({ where: { id }, data: { status, ...data } });
  }

  async remove(id: string): Promise<void> {
    await this.prisma.vendorDocument.delete({ where: { id } });
  }

  findApprovedButExpired(vendorId: string, asOf: Date): Promise<VendorDocument[]> {
    return this.prisma.vendorDocument.findMany({
      where: {
        vendorId,
        status: 'APPROVED',
        expiryDate: { lt: asOf },
      },
    });
  }
}
