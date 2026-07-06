import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SearchProductsDto } from './search-products.dto';

describe('SearchProductsDto', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', async () => {
    const dto = plainToInstance(SearchProductsDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });

  it('accepts explicit page and pageSize values', async () => {
    const dto = plainToInstance(SearchProductsDto, { page: '2', pageSize: '50' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(50);
  });

  it('rejects a pageSize above the maximum', async () => {
    const dto = plainToInstance(SearchProductsDto, { pageSize: '500' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
