import { BadRequestException } from '@nestjs/common';
import { ComplianceDocument } from '@prisma/client';

import { ComplianceDocumentsRepository } from '../repositories/compliance-documents.repository';
import { ComplianceDocumentsService } from './compliance-documents.service';

function buildDocument(overrides: Partial<ComplianceDocument> = {}): ComplianceDocument {
  return {
    id: 'doc-1',
    documentType: 'INSPECTION_REPORT',
    relatedLotId: 'lot-1',
    relatedRecallId: null,
    fileUrl: 'https://cdn.example.com/report.pdf',
    version: 1,
    uploadedById: 'admin-1',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('ComplianceDocumentsService', () => {
  let documentsRepository: jest.Mocked<
    Pick<ComplianceDocumentsRepository, 'create' | 'findLatestVersion' | 'findMany'>
  >;
  let service: ComplianceDocumentsService;

  beforeEach(() => {
    documentsRepository = { create: jest.fn(), findLatestVersion: jest.fn(), findMany: jest.fn() };
    service = new ComplianceDocumentsService(
      documentsRepository as unknown as ComplianceDocumentsRepository,
    );
  });

  describe('create', () => {
    const dto = {
      documentType: 'INSPECTION_REPORT' as const,
      relatedLotId: 'lot-1',
      fileUrl: 'https://cdn.example.com/report.pdf',
    };

    it('creates version 1 when no prior document exists', async () => {
      documentsRepository.findLatestVersion.mockResolvedValue(null);
      documentsRepository.create.mockResolvedValue(buildDocument({ version: 1 }));

      const result = await service.create('admin-1', dto);

      expect(result.version).toBe(1);
      expect(documentsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1, uploadedById: 'admin-1' }),
      );
    });

    it('bumps the version when a prior document exists for the same type+lot', async () => {
      documentsRepository.findLatestVersion.mockResolvedValue(buildDocument({ version: 3 }));
      documentsRepository.create.mockResolvedValue(buildDocument({ version: 4 }));

      const result = await service.create('admin-1', dto);

      expect(result.version).toBe(4);
      expect(documentsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ version: 4 }),
      );
    });

    it('rejects when both relatedLotId and relatedRecallId are set', async () => {
      await expect(
        service.create('admin-1', { ...dto, relatedRecallId: 'recall-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(documentsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects when neither relatedLotId nor relatedRecallId is set', async () => {
      await expect(
        service.create('admin-1', { documentType: 'AUDIT_REPORT', fileUrl: dto.fileUrl }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(documentsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists documents filtered by lot', async () => {
      documentsRepository.findMany.mockResolvedValue([buildDocument()]);

      const result = await service.list({ lotId: 'lot-1' });

      expect(result).toHaveLength(1);
      expect(documentsRepository.findMany).toHaveBeenCalledWith({
        relatedLotId: 'lot-1',
        relatedRecallId: undefined,
      });
    });
  });
});
