import { RegulatoryAuthority } from '@prisma/client';
import { RegulatoryAuthoritiesRepository } from '../repositories/regulatory-authorities.repository';
import { RegulatoryAuthoritiesService } from './regulatory-authorities.service';

function buildAuthority(overrides: Partial<RegulatoryAuthority> = {}): RegulatoryAuthority {
  return {
    id: 'authority-1',
    name: 'Fisheries Division / National Fisheries Authority',
    country: 'Jamaica',
    contactEmail: null,
    contactPhone: null,
    website: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RegulatoryAuthoritiesService', () => {
  let authoritiesRepository: jest.Mocked<Pick<RegulatoryAuthoritiesRepository, 'create' | 'findAll'>>;
  let service: RegulatoryAuthoritiesService;

  beforeEach(() => {
    authoritiesRepository = { create: jest.fn(), findAll: jest.fn() };
    service = new RegulatoryAuthoritiesService(
      authoritiesRepository as unknown as RegulatoryAuthoritiesRepository,
    );
  });

  describe('create', () => {
    it('creates and returns a regulatory authority', async () => {
      authoritiesRepository.create.mockResolvedValue(buildAuthority());

      const result = await service.create({ name: 'Fisheries Division / National Fisheries Authority' });

      expect(result.id).toBe('authority-1');
      expect(result.country).toBe('Jamaica');
      expect(authoritiesRepository.create).toHaveBeenCalledWith({
        name: 'Fisheries Division / National Fisheries Authority',
      });
    });
  });

  describe('list', () => {
    it('lists all authorities', async () => {
      authoritiesRepository.findAll.mockResolvedValue([buildAuthority(), buildAuthority({ id: 'authority-2' })]);

      const result = await service.list();

      expect(result).toHaveLength(2);
    });
  });
});
