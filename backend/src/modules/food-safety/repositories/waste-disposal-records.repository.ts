import { Injectable } from '@nestjs/common';
import { WasteDisposalRecord, WasteReason, WeightUnit } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateWasteDisposalRecordInput {
  lotId: string;
  productId?: string;
  recallId?: string;
  quantity: number;
  weightUnit: WeightUnit;
  reason: WasteReason;
  disposalMethod?: string;
  evidencePhotoUrls?: string[];
  witnessName?: string;
  witnessTitle?: string;
  witnessSignatureUrl?: string;
  recordedById: string;
}

@Injectable()
export class WasteDisposalRecordsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateWasteDisposalRecordInput): Promise<WasteDisposalRecord> {
    return this.prisma.wasteDisposalRecord.create({ data: input });
  }

  findMany(filters: { lotId?: string; recallId?: string }): Promise<WasteDisposalRecord[]> {
    return this.prisma.wasteDisposalRecord.findMany({
      where: {
        ...(filters.lotId ? { lotId: filters.lotId } : {}),
        ...(filters.recallId ? { recallId: filters.recallId } : {}),
      },
      orderBy: { disposedAt: 'desc' },
    });
  }
}
