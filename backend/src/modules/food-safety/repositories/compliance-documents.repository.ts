import { Injectable } from '@nestjs/common';
import { ComplianceDocument, ComplianceDocumentType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateComplianceDocumentInput {
  documentType: ComplianceDocumentType;
  relatedLotId?: string;
  relatedRecallId?: string;
  fileUrl: string;
  version: number;
  uploadedById: string;
}

@Injectable()
export class ComplianceDocumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateComplianceDocumentInput): Promise<ComplianceDocument> {
    return this.prisma.complianceDocument.create({ data: input });
  }

  findLatestVersion(
    documentType: ComplianceDocumentType,
    relatedLotId?: string,
    relatedRecallId?: string,
  ): Promise<ComplianceDocument | null> {
    return this.prisma.complianceDocument.findFirst({
      where: { documentType, relatedLotId: relatedLotId ?? null, relatedRecallId: relatedRecallId ?? null },
      orderBy: { version: 'desc' },
    });
  }

  findMany(filters: { relatedLotId?: string; relatedRecallId?: string }): Promise<ComplianceDocument[]> {
    const where: Prisma.ComplianceDocumentWhereInput = {
      ...(filters.relatedLotId ? { relatedLotId: filters.relatedLotId } : {}),
      ...(filters.relatedRecallId ? { relatedRecallId: filters.relatedRecallId } : {}),
    };
    return this.prisma.complianceDocument.findMany({ where, orderBy: [{ documentType: 'asc' }, { version: 'desc' }] });
  }
}
