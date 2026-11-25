import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';

import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { AnalyticsService } from '../services/analytics.service';
import { AnalyticsController } from './analytics.controller';

describe('AnalyticsController', () => {
  let analyticsService: jest.Mocked<
    Pick<
      AnalyticsService,
      | 'getDashboardSummary'
      | 'getVendorDashboard'
      | 'getSalesAnalytics'
      | 'getDeliveryAnalytics'
      | 'getInventoryAnalytics'
    >
  >;
  let controller: AnalyticsController;

  beforeEach(() => {
    analyticsService = {
      getDashboardSummary: jest.fn().mockResolvedValue({}),
      getVendorDashboard: jest.fn().mockResolvedValue({}),
      getSalesAnalytics: jest.fn().mockResolvedValue({}),
      getDeliveryAnalytics: jest.fn().mockResolvedValue({}),
      getInventoryAnalytics: jest.fn().mockResolvedValue({}),
    };
    controller = new AnalyticsController(analyticsService as unknown as AnalyticsService);
  });

  it('omits financial fields when dashboard summary and vendor dashboard are requested by operations staff', async () => {
    const staffUser = {
      id: 'staff-1',
      email: 'staff.operations@iriefishmongers.test',
      roles: [RoleName.OPERATIONS_STAFF],
    };

    await controller.getDashboardSummary({}, staffUser);
    expect(analyticsService.getDashboardSummary).toHaveBeenCalledWith(
      { from: undefined, to: undefined },
      { includeFinancials: false },
    );

    await controller.getVendorDashboard({}, staffUser);
    expect(analyticsService.getVendorDashboard).toHaveBeenCalledWith(
      { from: undefined, to: undefined },
      { includeFinancials: false },
    );
  });

  it('includes financial fields for administrators and restricts sales analytics strictly to ADMINISTRATOR', () => {
    const reflector = new Reflector();
    type MethodFn = (...args: unknown[]) => unknown;
    const methodTarget = (name: keyof AnalyticsController): MethodFn =>
      Reflect.get(AnalyticsController.prototype, name) as MethodFn;

    expect(reflector.get<RoleName[]>(ROLES_KEY, methodTarget('getSalesAnalytics'))).toEqual([
      RoleName.ADMINISTRATOR,
    ]);
    expect(
      reflector.get<RoleName[]>(ROLES_KEY, methodTarget('getDashboardSummary')),
    ).toEqual([RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF]);
    expect(
      reflector.get<RoleName[]>(ROLES_KEY, methodTarget('getVendorDashboard')),
    ).toEqual([RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF]);
    expect(
      reflector.get<RoleName[]>(ROLES_KEY, methodTarget('getDeliveryAnalytics')),
    ).toEqual([RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF]);
    expect(
      reflector.get<RoleName[]>(ROLES_KEY, methodTarget('getInventoryAnalytics')),
    ).toEqual([RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF]);
  });
});
