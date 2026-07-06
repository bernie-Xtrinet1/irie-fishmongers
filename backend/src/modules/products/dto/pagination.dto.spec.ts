import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PaginationDto } from './pagination.dto';

describe('PaginationDto', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', async () => {
    const dto = plainToInstance(PaginationDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });

  it('rejects a pageSize above the maximum', async () => {
    const dto = plainToInstance(PaginationDto, { pageSize: '500' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
