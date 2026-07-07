import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { ReviewVendorDocumentDto } from '../dto/review-vendor-document.dto';
import { UploadVendorDocumentDto } from '../dto/upload-vendor-document.dto';
import { VendorDocumentResponseEntity } from '../entities/vendor-document-response.entity';
import { VendorDocumentsService } from '../services/vendor-documents.service';
import { VendorDocumentsController } from './vendor-documents.controller';

const document: VendorDocumentResponseEntity = {
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
};

const vendorUser: RequestUser = { id: 'user-1', email: 'vera@example.com', roles: [RoleName.VENDOR] };

describe('VendorDocumentsController', () => {
  let documentsService: jest.Mocked<
    Pick<VendorDocumentsService, 'upload' | 'listMine' | 'removeMine' | 'listForVendor' | 'review'>
  >;
  let controller: VendorDocumentsController;

  beforeEach(() => {
    documentsService = {
      upload: jest.fn().mockResolvedValue(document),
      listMine: jest.fn().mockResolvedValue([document]),
      removeMine: jest.fn().mockResolvedValue(undefined),
      listForVendor: jest.fn().mockResolvedValue([document]),
      review: jest.fn().mockResolvedValue({ ...document, status: 'APPROVED' }),
    };
    controller = new VendorDocumentsController(documentsService as unknown as VendorDocumentsService);
  });

  it('uploads a document for the authenticated vendor', async () => {
    const dto: UploadVendorDocumentDto = {
      documentType: 'GOVERNMENT_ID',
      fileUrl: 'https://cdn.example.com/vendor-docs/government-id.jpg',
    };

    await expect(controller.upload(vendorUser, dto)).resolves.toEqual(document);
    expect(documentsService.upload).toHaveBeenCalledWith('user-1', dto);
  });

  it("lists the authenticated vendor's documents", async () => {
    await expect(controller.listMine(vendorUser)).resolves.toEqual([document]);
    expect(documentsService.listMine).toHaveBeenCalledWith('user-1');
  });

  it("removes one of the authenticated vendor's documents", async () => {
    await controller.removeMine(vendorUser, 'document-1');
    expect(documentsService.removeMine).toHaveBeenCalledWith('user-1', 'document-1');
  });

  it("lists a vendor's documents by vendor id (admin only)", async () => {
    await expect(controller.listForVendor('vendor-1')).resolves.toEqual([document]);
    expect(documentsService.listForVendor).toHaveBeenCalledWith('vendor-1');
  });

  it('reviews a pending vendor document', async () => {
    const adminUser: RequestUser = { id: 'admin-1', email: 'admin@example.com', roles: [RoleName.ADMINISTRATOR] };
    const dto: ReviewVendorDocumentDto = { decision: 'APPROVED' };

    const result = await controller.review(adminUser, 'document-1', dto);

    expect(result.status).toBe('APPROVED');
    expect(documentsService.review).toHaveBeenCalledWith('admin-1', 'document-1', dto);
  });
});
