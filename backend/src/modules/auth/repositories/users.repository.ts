import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const userWithRoles = Prisma.validator<Prisma.UserDefaultArgs>()({
  include: { roles: { include: { role: true } } },
});

export type UserWithRoles = Prisma.UserGetPayload<typeof userWithRoles>;

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone?: string;
  roleId: string;
  emailVerificationTokenHash: string;
  emailVerificationTokenExpiresAt: Date;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<UserWithRoles | null> {
    return this.prisma.user.findUnique({
      where: { email },
      include: userWithRoles.include,
    });
  }

  findById(id: string): Promise<UserWithRoles | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: userWithRoles.include,
    });
  }

  findByEmailVerificationTokenHash(tokenHash: string): Promise<UserWithRoles | null> {
    return this.prisma.user.findFirst({
      where: { emailVerificationTokenHash: tokenHash },
      include: userWithRoles.include,
    });
  }

  findByPasswordResetTokenHash(tokenHash: string): Promise<UserWithRoles | null> {
    return this.prisma.user.findFirst({
      where: { passwordResetTokenHash: tokenHash },
      include: userWithRoles.include,
    });
  }

  create(input: CreateUserInput): Promise<UserWithRoles> {
    return this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        emailVerificationTokenHash: input.emailVerificationTokenHash,
        emailVerificationTokenExpiresAt: input.emailVerificationTokenExpiresAt,
        roles: { create: [{ roleId: input.roleId }] },
      },
      include: userWithRoles.include,
    });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiresAt: null,
      },
    });
  }

  async setPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt },
    });
  }

  async resetPassword(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });
  }

  static toRoleNames(user: UserWithRoles): RoleName[] {
    return user.roles.map((userRole) => userRole.role.name);
  }
}
