import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { QualityInspectionResponseEntity } from '../entities/quality-inspection-response.entity';
import { QualityInspectionsService } from '../services/quality-inspections.service';
import { QualityInspectionsController } from './quality-inspections.controller';

const inspection: QualityInspectionResponseEntity = {
  id: 'inspection-1',
  lotId: 'lot-1',
  inspectorId: 'admin-1',
  result: 'PASSED',
  freshnessGrade: 'GRADE_A',
  qualityScore: 95,
  notes: null,
  photoUrl: null,
  inspectedAt: new Date(),
};

const adminUser: RequestUser = { id: 'admin-1', email: 'a@example.com', roles: [RoleName.ADMINISTRATOR] };

describe('QualityInspectionsController', () => {
  let qualityInspectionsService: jest.Mocked<Pick<QualityInspectionsService, 'inspect' | 'getForLot'>>;
  let controller: QualityInspectionsController;

  beforeEach(() => {
    qualityInspectionsService = {
      inspect: jest.fn().mockResolvedValue(inspection),
      getForLot: jest.fn().mockResolvedValue({ items: [inspection], total: 1, page: 1, pageSize: 20 }),
    };
    controller = new QualityInspectionsController(
      qualityInspectionsService as unknown as QualityInspectionsService,
    );
  });

  it('records a quality inspection', async () => {
    const dto = {
      lotId: 'lot-1',
      result: 'PASSED' as const,
      freshnessGrade: 'GRADE_A' as const,
      qualityScore: 95,
    };
    await expect(controller.inspect(adminUser, dto)).resolves.toEqual(inspection);
    expect(qualityInspectionsService.inspect).toHaveBeenCalledWith('admin-1', dto);
  });

  it("gets a lot's inspection history", async () => {
    const result = await controller.getForLot(adminUser, 'lot-1', { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(qualityInspectionsService.getForLot).toHaveBeenCalledWith(adminUser, 'lot-1', {
      page: 1,
      pageSize: 20,
    });
  });
});
