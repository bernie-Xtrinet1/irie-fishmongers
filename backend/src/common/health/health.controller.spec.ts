import { HttpException } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let healthService: jest.Mocked<Pick<HealthService, 'checkStatus'>>;
  let controller: HealthController;

  beforeEach(() => {
    healthService = { checkStatus: jest.fn() };
    controller = new HealthController(healthService as unknown as HealthService);
  });

  it('reports both dependencies up', async () => {
    healthService.checkStatus.mockResolvedValue({ postgres: 'up', redis: 'up' });

    await expect(controller.check()).resolves.toEqual({ postgres: 'up', redis: 'up' });
  });

  it('throws 503 when postgres is unreachable', async () => {
    healthService.checkStatus.mockResolvedValue({ postgres: 'down', redis: 'up' });

    await expect(controller.check()).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 503 when redis is unreachable', async () => {
    healthService.checkStatus.mockResolvedValue({ postgres: 'up', redis: 'down' });

    await expect(controller.check()).rejects.toBeInstanceOf(HttpException);
  });

  describe('checkStatus', () => {
    it('always resolves 200 with the granular status, even when a dependency is down', async () => {
      healthService.checkStatus.mockResolvedValue({ postgres: 'up', redis: 'down' });

      await expect(controller.checkStatus()).resolves.toEqual({ postgres: 'up', redis: 'down' });
    });
  });
});
