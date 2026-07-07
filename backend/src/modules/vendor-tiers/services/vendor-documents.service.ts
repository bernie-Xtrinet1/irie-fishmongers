import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { VendorDocument, VendorTier } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ReviewVendorDocumentDto } from '../dto/review-vendor-document.dto';
import { UploadVendorDocumentDto } from '../dto/upload-vendor-document.dto';
import { VendorDocumentResponseEntity } from '../entities/vendor-document-response.entity';
import { VendorDocumentsRepository } from '../repositories/vendor-documents.repository';
import { REQUIRED_DOCUMENTS_BY_TIER } from '../vendor-tier.constants';

@Injectable()
export class VendorDocumentsService {
  constructor(
    private readonly documentsRepository: VendorDocumentsRepository,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async upload(userId: string, dto: UploadVendorDocumentDto): Promise<VendorDocumentResponseEntity> {
    const vendor = await this.getOwnVendorProfile(userId);

    const created = await this.documentsRepository.create({
      vendorId: vendor.id,
      documentType: dto.documentType,
      fileUrl: dto.fileUrl,
      documentNumber: dto.documentNumber,
      issuedDate: dto.issuedDate ? new Date(dto.issuedDate) : undefined,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
    });

    return VendorDocumentsService.toResponse(created);
  }

  async listMine(userId: string): Promise<VendorDocumentResponseEntity[]> {
    const vendor = await this.getOwnVendorProfile(userId);
    const documents = await this.syncExpiredStatuses(vendor.id);
    return documents.map((document) => VendorDocumentsService.toResponse(document));
  }

  async listForVendor(vendorId: string): Promise<VendorDocumentResponseEntity[]> {
    const documents = await this.syncExpiredStatuses(vendorId);
    return documents.map((document) => VendorDocumentsService.toResponse(document));
  }

  async removeMine(userId: string, documentId: string): Promise<void> {
    const vendor = await this.getOwnVendorProfile(userId);
    const document = await this.documentsRepository.findById(documentId);
    if (!document || document.vendorId !== vendor.id) {
      throw new NotFoundException('Document not found');
    }
    if (document.status === 'APPROVED') {
      throw new BadRequestException('An approved document cannot be removed - upload a replacement instead');
    }
    await this.documentsRepository.remove(documentId);
  }

  async review(
    adminId: string,
    documentId: string,
    dto: ReviewVendorDocumentDto,
  ): Promise<VendorDocumentResponseEntity> {
    const document = await this.documentsRepository.findById(documentId);
    if (!document) {
      throw new NotFoundException('Document not found');
    }
    if (document.status !== 'PENDING') {
      throw new BadRequestException('Only a pending document can be reviewed');
    }

    if (dto.decision === 'REJECTED' && !dto.rejectionReason) {
      throw new BadRequestException('A rejection reason is required');
    }

    const updated = await this.documentsRepository.updateStatus(documentId, dto.decision, {
      verifiedById: adminId,
      verifiedAt: new Date(),
      rejectionReason: dto.decision === 'REJECTED' ? dto.rejectionReason : undefined,
    });

    return VendorDocumentsService.toResponse(updated);
  }

  /**
   * vendor-tier-rules.md's Registration/Compliance Rules ("A vendor may not
   * create products unless canSell === true"): a vendor may sell once every
   * document type their current tier requires has an APPROVED row.
   */
  async computeCanSell(vendorId: string, tier: VendorTier): Promise<boolean> {
    const required = REQUIRED_DOCUMENTS_BY_TIER[tier];
    if (required.length === 0) {
      return true;
    }

    const documents = await this.syncExpiredStatuses(vendorId);
    return required.every((documentType) =>
      documents.some((document) => document.documentType === documentType && document.status === 'APPROVED'),
    );
  }

  async assertCanSell(vendorId: string, tier: VendorTier): Promise<void> {
    const canSell = await this.computeCanSell(vendorId, tier);
    if (!canSell) {
      throw new ForbiddenException(
        'This vendor is missing required, approved compliance documents for their tier',
      );
    }
  }

  /**
   * vendor-tier-rules.md: "The system shall automatically detect expired
   * documents... Expired documents shall be marked EXPIRED." No scheduler
   * exists in this codebase (same class of gap as the Notifications phase's
   * deferred retry ladder), so detection happens lazily whenever a vendor's
   * documents are actually read, rather than via a background sweep.
   */
  private async syncExpiredStatuses(vendorId: string): Promise<VendorDocument[]> {
    const expired = await this.documentsRepository.findApprovedButExpired(vendorId, new Date());
    await Promise.all(
      expired.map((document) => this.documentsRepository.updateStatus(document.id, 'EXPIRED')),
    );
    return this.documentsRepository.findByVendorId(vendorId);
  }

  private async getOwnVendorProfile(userId: string): Promise<{ id: string }> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return vendor;
  }

  private static toResponse(document: VendorDocument): VendorDocumentResponseEntity {
    return {
      id: document.id,
      vendorId: document.vendorId,
      documentType: document.documentType,
      fileUrl: document.fileUrl,
      documentNumber: document.documentNumber,
      issuedDate: document.issuedDate,
      expiryDate: document.expiryDate,
      status: document.status,
      rejectionReason: document.rejectionReason,
      verifiedById: document.verifiedById,
      verifiedAt: document.verifiedAt,
      createdAt: document.createdAt,
    };
  }
}
