import { validate } from 'class-validator';

import { Match } from './match.validator';

class TestDto {
  password!: string;

  @Match('password')
  confirmPassword!: string;
}

describe('Match', () => {
  it('passes when the two properties are equal', async () => {
    const dto = new TestDto();
    dto.password = 'abc123';
    dto.confirmPassword = 'abc123';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when the two properties differ', async () => {
    const dto = new TestDto();
    dto.password = 'abc123';
    dto.confirmPassword = 'different';

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toEqual({
      match: 'confirmPassword must match password',
    });
  });
});
