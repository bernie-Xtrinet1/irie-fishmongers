import { RoleName, UserStatus } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';

export interface VerifiedCatalogueActor {
  id: string;
  email: string;
  status: UserStatus;
  roles: RoleName[];
  canManageCataloguePhotos: boolean;
}

/**
 * Loads live user status, roles, and explicit catalogue permission from the database
 * when PrismaService is wired; falls back gracefully in unit tests without Prisma.
 */
export async function resolveCatalogueActor(
  user: RequestUser | undefined,
  prisma?: PrismaService,
): Promise<VerifiedCatalogueActor | null> {
  if (!user?.id) {
    return null;
  }

  if (typeof prisma?.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        status: true,
        canManageCataloguePhotos: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
    if (!dbUser) {
      return null;
    }
    return {
      id: dbUser.id,
      email: dbUser.email,
      status: dbUser.status,
      roles: dbUser.roles.map((entry) => entry.role.name),
      canManageCataloguePhotos: Boolean(dbUser.canManageCataloguePhotos),
    };
  }

  return {
    id: user.id,
    email: user.email,
    status: UserStatus.ACTIVE,
    roles: user.roles ?? [],
    canManageCataloguePhotos: Boolean(user.canManageCataloguePhotos),
  };
}
