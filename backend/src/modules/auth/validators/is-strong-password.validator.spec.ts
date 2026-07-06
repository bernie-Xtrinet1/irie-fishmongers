import { validate } from 'class-validator';

import { IsStrongPassword } from './is-strong-password.validator';

class TestDto {
  @IsStrongPassword()
  password!: string;
}

async function validatePassword(password: string): Promise<boolean> {
  const dto = new TestDto();
  dto.password = password;
  const errors = await validate(dto);
  return errors.length === 0;
}

describe('IsStrongPassword', () => {
  it('accepts a password with upper, lower, number, and 8+ chars', async () => {
    await expect(validatePassword('StrongPass1')).resolves.toBe(true);
  });

  it('rejects a password shorter than 8 characters', async () => {
    await expect(validatePassword('Str1')).resolves.toBe(false);
  });

  it('rejects a password without an uppercase letter', async () => {
    await expect(validatePassword('strongpass1')).resolves.toBe(false);
  });

  it('rejects a password without a lowercase letter', async () => {
    await expect(validatePassword('STRONGPASS1')).resolves.toBe(false);
  });

  it('rejects a password without a number', async () => {
    await expect(validatePassword('StrongPass')).resolves.toBe(false);
  });
});
