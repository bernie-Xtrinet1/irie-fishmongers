import { ComplianceAuditLogsRepository } from '../repositories/compliance-audit-logs.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';

describe('ComplianceAuditLogService', () => {
  let auditLogsRepository: jest.Mocked<Pick<ComplianceAuditLogsRepository, 'create' | 'findMany'>>;
  let service: ComplianceAuditLogService;

  beforeEach(() => {
    auditLogsRepository = { create: jest.fn(), findMany: jest.fn() };
    service = new ComplianceAuditLogService(
      auditLogsRepository as unknown as ComplianceAuditLogsRepository,
    );
  });

  describe('record', () => {
    it('writes an audit log entry', async () => {
      const created = {
        id: 'log-1',
        userId: 'admin-1',
        action: 'SEAFOOD_LOT_STATUS_UPDATED',
        entityType: 'SeafoodLot',
        entityId: 'lot-1',
        beforeValue: { foodSafetyStatus: 'SAFE' },
        afterValue: { foodSafetyStatus: 'QUARANTINED' },
        ipAddress: '127.0.0.1',
        reason: 'Cleared after review',
        createdAt: new Date(),
      };
      auditLogsRepository.create.mockResolvedValue(created);

      const result = await service.record({
        userId: 'admin-1',
        action: 'SEAFOOD_LOT_STATUS_UPDATED',
        entityType: 'SeafoodLot',
        entityId: 'lot-1',
        beforeValue: { foodSafetyStatus: 'SAFE' },
        afterValue: { foodSafetyStatus: 'QUARANTINED' },
        ipAddress: '127.0.0.1',
        reason: 'Cleared after review',
      });

      expect(result).toEqual(created);
      expect(auditLogsRepository.create).toHaveBeenCalledWith({
        userId: 'admin-1',
        action: 'SEAFOOD_LOT_STATUS_UPDATED',
        entityType: 'SeafoodLot',
        entityId: 'lot-1',
        beforeValue: { foodSafetyStatus: 'SAFE' },
        afterValue: { foodSafetyStatus: 'QUARANTINED' },
        ipAddress: '127.0.0.1',
        reason: 'Cleared after review',
      });
    });

    it('swallows a repository failure and returns null rather than rejecting', async () => {
      auditLogsRepository.create.mockRejectedValue(new Error('DB unavailable'));

      const result = await service.record({
        userId: 'admin-1',
        action: 'SEAFOOD_LOT_STATUS_UPDATED',
        entityType: 'SeafoodLot',
        entityId: 'lot-1',
      });

      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('paginates and filters by entity', async () => {
      auditLogsRepository.findMany.mockResolvedValue({
        items: [
          {
            id: 'log-1',
            userId: 'admin-1',
            action: 'RECALL_STATUS_UPDATED',
            entityType: 'Recall',
            entityId: 'recall-1',
            beforeValue: null,
            afterValue: null,
            ipAddress: null,
            reason: null,
            createdAt: new Date(),
          },
        ],
        total: 1,
      });

      const result = await service.list({ entityType: 'Recall', entityId: 'recall-1' }, { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]?.entityType).toBe('Recall');
      expect(auditLogsRepository.findMany).toHaveBeenCalledWith(
        { entityType: 'Recall', entityId: 'recall-1' },
        { skip: 0, take: 20 },
      );
    });
  });
});
