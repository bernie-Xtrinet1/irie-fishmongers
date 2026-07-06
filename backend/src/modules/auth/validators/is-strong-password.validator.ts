import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && STRONG_PASSWORD_PATTERN.test(value);
        },
        defaultMessage(_args: ValidationArguments): string {
          return 'password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number';
        },
      },
    });
  };
}
