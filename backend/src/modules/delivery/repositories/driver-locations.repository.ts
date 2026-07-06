import { Injectable } from '@nestjs/common';
import { DriverLocation } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class DriverLocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  record(driverId: string, latitude: number, longitude: number): Promise<DriverLocation> {
    return this.prisma.driverLocation.create({ data: { driverId, latitude, longitude } });
  }

  findLatestByDriverId(driverId: string): Promise<DriverLocation | null> {
    return this.prisma.driverLocation.findFirst({
      where: { driverId },
      orderBy: { recordedAt: 'desc' },
    });
  }
}
