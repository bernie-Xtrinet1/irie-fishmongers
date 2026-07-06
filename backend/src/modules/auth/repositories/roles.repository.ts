import { Injectable } from '@nestjs/common';
import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class RolesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByName(name: RoleName): Promise<Role | null> {
    return this.prisma.role.findUnique({ where: { name } });
  }
}
