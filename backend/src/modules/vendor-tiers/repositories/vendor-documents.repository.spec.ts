import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorDocumentsRepository } from './vendor-documents.repository';

describe('VendorDocumentsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorDocumentsRepository;
  let vendorUserId: string;
  let vendorId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorDocumentsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const vendorUser = await usersRepository.create({
      email: `vendor-documents-repo-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    vendorId = vendor.id;
  });

  afterAll(async () => {
    await prisma.vendorDocument.deleteMany({ where: { vendorId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a document in PENDING status', async () => {
    const document = await repository.create({
      vendorId,
      documentType: 'GOVERNMENT_ID',
      fileUrl: 'https://cdn.example.com/vendor-docs/gov-id.jpg',
    });

    expect(document.status).toBe('PENDING');
    expect(document.vendorId).toBe(vendorId);
    expect(document.documentType).toBe('GOVERNMENT_ID');
  });

  it('finds a document by id', async () => {
    const created = await repository.create({
      vendorId,
      documentType: 'BUSINESS_REGISTRATION',
      fileUrl: 'https://cdn.example.com/vendor-docs/business-reg.jpg',
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when a document does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('finds all documents for a vendor ordered by createdAt desc', async () => {
    const first = await repository.create({
      vendorId,
      documentType: 'TAX_COMPLIANCE_CERTIFICATE',
      fileUrl: 'https://cdn.example.com/vendor-docs/tax-1.jpg',
    });
    const second = await repository.create({
      vendorId,
      documentType: 'INSURANCE_CERTIFICATE',
      fileUrl: 'https://cdn.example.com/vendor-docs/insurance-1.jpg',
    });

    const documents = await repository.findByVendorId(vendorId);
    expect(documents.every((document) => document.vendorId === vendorId)).toBe(true);
    const firstIndex = documents.findIndex((document) => document.id === first.id);
    const secondIndex = documents.findIndex((document) => document.id === second.id);
    expect(secondIndex).toBeLessThan(firstIndex);
  });

  it('updates document status with extra fields', async () => {
    const created = await repository.create({
      vendorId,
      documentType: 'FOOD_SAFETY_DOCUMENTATION',
      fileUrl: 'https://cdn.example.com/vendor-docs/food-safety.jpg',
    });

    const verifiedAt = new Date();
    const updated = await repository.updateStatus(created.id, 'APPROVED', {
      verifiedById: vendorUserId,
      verifiedAt,
    });

    expect(updated.status).toBe('APPROVED');
    expect(updated.verifiedById).toBe(vendorUserId);
  });

  it('updates document status without extra fields', async () => {
    const created = await repository.create({
      vendorId,
      documentType: 'REGULATORY_CERTIFICATION',
      fileUrl: 'https://cdn.example.com/vendor-docs/regulatory.jpg',
    });

    const updated = await repository.updateStatus(created.id, 'REJECTED');
    expect(updated.status).toBe('REJECTED');
  });

  it('removes a document', async () => {
    const created = await repository.create({
      vendorId,
      documentType: 'OTHER',
      fileUrl: 'https://cdn.example.com/vendor-docs/other.jpg',
    });

    await repository.remove(created.id);
    await expect(repository.findById(created.id)).resolves.toBeNull();
  });

  describe('findApprovedButExpired', () => {
    it('returns only APPROVED documents whose expiryDate has passed', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const expiredApproved = await repository.create({
        vendorId,
        documentType: 'GOVERNMENT_ID',
        fileUrl: 'https://cdn.example.com/vendor-docs/expired.jpg',
        expiryDate: past,
      });
      await repository.updateStatus(expiredApproved.id, 'APPROVED');

      const notYetExpiredApproved = await repository.create({
        vendorId,
        documentType: 'BUSINESS_REGISTRATION',
        fileUrl: 'https://cdn.example.com/vendor-docs/not-expired.jpg',
        expiryDate: future,
      });
      await repository.updateStatus(notYetExpiredApproved.id, 'APPROVED');

      const expiredButPending = await repository.create({
        vendorId,
        documentType: 'INSURANCE_CERTIFICATE',
        fileUrl: 'https://cdn.example.com/vendor-docs/expired-pending.jpg',
        expiryDate: past,
      });

      const results = await repository.findApprovedButExpired(vendorId, new Date());
      const resultIds = results.map((document) => document.id);

      expect(resultIds).toContain(expiredApproved.id);
      expect(resultIds).not.toContain(notYetExpiredApproved.id);
      expect(resultIds).not.toContain(expiredButPending.id);
    });
  });
});
