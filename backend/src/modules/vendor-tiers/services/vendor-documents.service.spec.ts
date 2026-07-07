import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Vendor, VendorDocument } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ReviewVendorDocumentDto } from '../dto/review-vendor-document.dto';
import { UploadVendorDocumentDto } from '../dto/upload-vendor-document.dto';
import { VendorDocumentsRepository } from '../repositories/vendor-documents.repository';
import { VendorDocumentsService } from './vendor-documents.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    termsAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildDocument(overrides: Partial<VendorDocument> = {}): VendorDocument {
  return {
    id: 'document-1',
    vendorId: 'vendor-1',
    documentType: 'GOVERNMENT_ID',
    fileUrl: 'https://cdn.example.com/vendor-docs/government-id.jpg',
    documentNumber: null,
    issuedDate: null,
    expiryDate: null,
    status: 'PENDING',
    rejectionReason: null,
    verifiedById: null,
    verifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('VendorDocumentsService', () => {
  let documentsRepository: jest.Mocked<
    Pick<
      VendorDocumentsRepository,
      'create' | 'findById' | 'findByVendorId' | 'updateStatus' | 'remove' | 'findApprovedButExpired'
    >
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let service: VendorDocumentsService;

  beforeEach(() => {
    documentsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByVendorId: jest.fn(),
      updateStatus: jest.fn(),
      remove: jest.fn(),
      findApprovedButExpired: jest.fn(),
    };
    vendorsRepository = { findByUserId: jest.fn() };
    documentsRepository.findApprovedButExpired.mockResolvedValue([]);

    service = new VendorDocumentsService(
      documentsRepository as unknown as VendorDocumentsRepository,
      vendorsRepository as unknown as VendorsRepository,
    );
  });

  describe('upload', () => {
    const dto: UploadVendorDocumentDto = {
      documentType: 'GOVERNMENT_ID',
      fileUrl: 'https://cdn.example.com/vendor-docs/government-id.jpg',
    };

    it('uploads a document for the calling vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.create.mockResolvedValue(buildDocument());

      const result = await service.upload('user-1', dto);

      expect(result.id).toBe('document-1');
      expect(documentsRepository.create).toHaveBeenCalledWith({
        vendorId: 'vendor-1',
        documentType: 'GOVERNMENT_ID',
        fileUrl: dto.fileUrl,
        documentNumber: undefined,
        issuedDate: undefined,
        expiryDate: undefined,
      });
    });

    it('parses issuedDate and expiryDate strings into Dates', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.create.mockResolvedValue(buildDocument());

      await service.upload('user-1', {
        ...dto,
        documentNumber: 'ID-12345',
        issuedDate: '2024-01-15',
        expiryDate: '2027-01-15',
      });

      expect(documentsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          documentNumber: 'ID-12345',
          issuedDate: new Date('2024-01-15'),
          expiryDate: new Date('2027-01-15'),
        }),
      );
    });

    it('throws NotFoundException when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.upload('user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listMine', () => {
    it('returns the calling vendor documents after syncing expired statuses', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([buildDocument()]);

      const result = await service.listMine('user-1');

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('document-1');
    });

    it('throws NotFoundException when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.listMine('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listForVendor', () => {
    it('returns documents for the given vendor id', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([buildDocument()]);

      const result = await service.listForVendor('vendor-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('lazy expiry sync', () => {
    it('transitions an APPROVED document with a past expiryDate to EXPIRED before returning it', async () => {
      const expiredDocument = buildDocument({
        id: 'document-expired',
        status: 'APPROVED',
        expiryDate: new Date('2020-01-01'),
      });
      documentsRepository.findApprovedButExpired.mockResolvedValue([expiredDocument]);
      documentsRepository.updateStatus.mockResolvedValue({ ...expiredDocument, status: 'EXPIRED' });
      documentsRepository.findByVendorId.mockResolvedValue([
        { ...expiredDocument, status: 'EXPIRED' },
      ]);

      const result = await service.listForVendor('vendor-1');

      expect(documentsRepository.updateStatus).toHaveBeenCalledWith('document-expired', 'EXPIRED');
      expect(result[0]?.status).toBe('EXPIRED');
    });

    it('does not update anything when there are no expired documents', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([buildDocument()]);

      await service.listForVendor('vendor-1');

      expect(documentsRepository.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('removeMine', () => {
    it('removes a non-approved document belonging to the calling vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'PENDING' }));

      await service.removeMine('user-1', 'document-1');

      expect(documentsRepository.remove).toHaveBeenCalledWith('document-1');
    });

    it.each(['PENDING', 'REJECTED', 'EXPIRED'] as const)(
      'allows removal when status is %s',
      async (status) => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        documentsRepository.findById.mockResolvedValue(buildDocument({ status }));

        await expect(service.removeMine('user-1', 'document-1')).resolves.toBeUndefined();
      },
    );

    it('throws BadRequestException when the document is APPROVED', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'APPROVED' }));

      await expect(service.removeMine('user-1', 'document-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(documentsRepository.remove).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the document does not exist', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      documentsRepository.findById.mockResolvedValue(null);

      await expect(service.removeMine('user-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws NotFoundException when the document belongs to a different vendor", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-1' }));
      documentsRepository.findById.mockResolvedValue(buildDocument({ vendorId: 'vendor-2' }));

      await expect(service.removeMine('user-1', 'document-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFoundException when no vendor profile exists for the caller', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.removeMine('user-1', 'document-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('review', () => {
    it('approves a pending document', async () => {
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'PENDING' }));
      documentsRepository.updateStatus.mockResolvedValue(buildDocument({ status: 'APPROVED' }));

      const dto: ReviewVendorDocumentDto = { decision: 'APPROVED' };
      const result = await service.review('admin-1', 'document-1', dto);

      expect(result.status).toBe('APPROVED');
      expect(documentsRepository.updateStatus).toHaveBeenCalledWith('document-1', 'APPROVED', {
        verifiedById: 'admin-1',
        verifiedAt: expect.any(Date) as Date,
        rejectionReason: undefined,
      });
    });

    it('rejects a pending document with a rejection reason', async () => {
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'PENDING' }));
      documentsRepository.updateStatus.mockResolvedValue(
        buildDocument({ status: 'REJECTED', rejectionReason: 'Illegible image' }),
      );

      const dto: ReviewVendorDocumentDto = { decision: 'REJECTED', rejectionReason: 'Illegible image' };
      const result = await service.review('admin-1', 'document-1', dto);

      expect(result.status).toBe('REJECTED');
      expect(documentsRepository.updateStatus).toHaveBeenCalledWith('document-1', 'REJECTED', {
        verifiedById: 'admin-1',
        verifiedAt: expect.any(Date) as Date,
        rejectionReason: 'Illegible image',
      });
    });

    it('throws BadRequestException when rejecting without a rejectionReason', async () => {
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'PENDING' }));

      const dto: ReviewVendorDocumentDto = { decision: 'REJECTED' };
      await expect(service.review('admin-1', 'document-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(documentsRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the document is not PENDING', async () => {
      documentsRepository.findById.mockResolvedValue(buildDocument({ status: 'APPROVED' }));

      const dto: ReviewVendorDocumentDto = { decision: 'APPROVED' };
      await expect(service.review('admin-1', 'document-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFoundException when the document does not exist', async () => {
      documentsRepository.findById.mockResolvedValue(null);

      const dto: ReviewVendorDocumentDto = { decision: 'APPROVED' };
      await expect(service.review('admin-1', 'missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('computeCanSell', () => {
    // Every VendorTier in REQUIRED_DOCUMENTS_BY_TIER has at least one
    // required document type today (COMMUNITY_FISHER requires only
    // GOVERNMENT_ID), so the "required.length === 0" early-return branch is
    // not reachable through any real tier value and is not asserted
    // directly - the single-requirement COMMUNITY_FISHER case below is the
    // simplest real exercise of the "required documents satisfied" path.
    it('returns true for COMMUNITY_FISHER once its single required document is APPROVED', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ documentType: 'GOVERNMENT_ID', status: 'APPROVED' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'COMMUNITY_FISHER')).resolves.toBe(true);
    });

    it('returns true when every required document type has an APPROVED row', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ id: 'd1', documentType: 'GOVERNMENT_ID', status: 'APPROVED' }),
        buildDocument({ id: 'd2', documentType: 'BUSINESS_REGISTRATION', status: 'APPROVED' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'VERIFIED_VENDOR')).resolves.toBe(true);
    });

    it('returns false when a required document type is missing entirely', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ id: 'd1', documentType: 'GOVERNMENT_ID', status: 'APPROVED' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'VERIFIED_VENDOR')).resolves.toBe(false);
    });

    it('returns false when a required document type exists but is not APPROVED', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ id: 'd1', documentType: 'GOVERNMENT_ID', status: 'APPROVED' }),
        buildDocument({ id: 'd2', documentType: 'BUSINESS_REGISTRATION', status: 'PENDING' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'VERIFIED_VENDOR')).resolves.toBe(false);
    });

    it('requires all 5 document types for ENTERPRISE_SUPPLIER', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ id: 'd1', documentType: 'BUSINESS_REGISTRATION', status: 'APPROVED' }),
        buildDocument({ id: 'd2', documentType: 'TAX_COMPLIANCE_CERTIFICATE', status: 'APPROVED' }),
        buildDocument({ id: 'd3', documentType: 'INSURANCE_CERTIFICATE', status: 'APPROVED' }),
        buildDocument({ id: 'd4', documentType: 'FOOD_SAFETY_DOCUMENTATION', status: 'APPROVED' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'ENTERPRISE_SUPPLIER')).resolves.toBe(false);

      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ id: 'd1', documentType: 'BUSINESS_REGISTRATION', status: 'APPROVED' }),
        buildDocument({ id: 'd2', documentType: 'TAX_COMPLIANCE_CERTIFICATE', status: 'APPROVED' }),
        buildDocument({ id: 'd3', documentType: 'INSURANCE_CERTIFICATE', status: 'APPROVED' }),
        buildDocument({ id: 'd4', documentType: 'FOOD_SAFETY_DOCUMENTATION', status: 'APPROVED' }),
        buildDocument({ id: 'd5', documentType: 'REGULATORY_CERTIFICATION', status: 'APPROVED' }),
      ]);

      await expect(service.computeCanSell('vendor-1', 'ENTERPRISE_SUPPLIER')).resolves.toBe(true);
    });
  });

  describe('assertCanSell', () => {
    it('does not throw when computeCanSell resolves true', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([
        buildDocument({ documentType: 'GOVERNMENT_ID', status: 'APPROVED' }),
      ]);

      await expect(service.assertCanSell('vendor-1', 'COMMUNITY_FISHER')).resolves.toBeUndefined();
    });

    it('throws ForbiddenException when computeCanSell resolves false', async () => {
      documentsRepository.findApprovedButExpired.mockResolvedValue([]);
      documentsRepository.findByVendorId.mockResolvedValue([]);

      await expect(service.assertCanSell('vendor-1', 'COMMUNITY_FISHER')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
