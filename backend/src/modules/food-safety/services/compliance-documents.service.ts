import { BadRequestException, Injectable } from '@nestjs/common';

import { CreateComplianceDocumentDto } from '../dto/create-compliance-document.dto';
import { ComplianceDocumentResponseEntity } from '../entities/compliance-document-response.entity';
import { ComplianceDocumentsRepository } from '../repositories/compliance-documents.repository';

// Versioned: a new upload for the same documentType + relatedLotId/
// relatedRecallId bumps version rather than overwriting the prior one,
// per seafood-compliance-rules.md's "Documents must be versioned."
@Injectable()
export class ComplianceDocumentsService {
  constructor(private readonly documentsRepository: ComplianceDocumentsRepository) {}

  async create(
    uploadedById: string,
    dto: CreateComplianceDocumentDto,
  ): Promise<ComplianceDocumentResponseEntity> {
    if (Boolean(dto.relatedLotId) === Boolean(dto.relatedRecallId)) {
      throw new BadRequestException('Exactly one of relatedLotId or relatedRecallId must be set');
    }

    const latest = await this.documentsRepository.findLatestVersion(
      dto.documentType,
      dto.relatedLotId,
      dto.relatedRecallId,
    );

    const document = await this.documentsRepository.create({
      documentType: dto.documentType,
      relatedLotId: dto.relatedLotId,
      relatedRecallId: dto.relatedRecallId,
      fileUrl: dto.fileUrl,
      version: (latest?.version ?? 0) + 1,
      uploadedById,
    });

    return document;
  }

  list(filters: { lotId?: string; recallId?: string }): Promise<ComplianceDocumentResponseEntity[]> {
    return this.documentsRepository.findMany({
      relatedLotId: filters.lotId,
      relatedRecallId: filters.recallId,
    });
  }
}
