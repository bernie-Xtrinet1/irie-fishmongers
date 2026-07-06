import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListVendorsDto } from './list-vendors.dto';

describe('ListVendorsDto', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', async () => {
    const dto = plainToInstance(ListVendorsDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
    expect(dto.status).toBeUndefined();
  });

  it('accepts a valid status filter', async () => {
    const dto = plainToInstance(ListVendorsDto, { status: 'APPROVED' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid status value', async () => {
    const dto = plainToInstance(ListVendorsDto, { status: 'NOT_A_STATUS' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
