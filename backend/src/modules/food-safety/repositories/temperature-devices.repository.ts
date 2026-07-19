import { Injectable } from '@nestjs/common';
import { DeviceStatus, TemperatureDevice } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateTemperatureDeviceInput {
  vendorId: string;
  deviceCode: string;
}

@Injectable()
export class TemperatureDevicesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateTemperatureDeviceInput): Promise<TemperatureDevice> {
    return this.prisma.temperatureDevice.create({ data: input });
  }

  findById(id: string): Promise<TemperatureDevice | null> {
    return this.prisma.temperatureDevice.findUnique({ where: { id } });
  }

  findByDeviceCode(deviceCode: string): Promise<TemperatureDevice | null> {
    return this.prisma.temperatureDevice.findUnique({ where: { deviceCode } });
  }

  touchLastSeen(id: string): Promise<TemperatureDevice> {
    return this.prisma.temperatureDevice.update({ where: { id }, data: { lastSeenAt: new Date() } });
  }

  calibrate(id: string, calibratedAt: Date, dueAt: Date): Promise<TemperatureDevice> {
    return this.prisma.temperatureDevice.update({
      where: { id },
      data: { lastCalibratedAt: calibratedAt, calibrationDueAt: dueAt },
    });
  }

  updateStatus(id: string, status: DeviceStatus): Promise<TemperatureDevice> {
    return this.prisma.temperatureDevice.update({ where: { id }, data: { status } });
  }

  findMany(vendorId?: string): Promise<TemperatureDevice[]> {
    return this.prisma.temperatureDevice.findMany({
      where: vendorId ? { vendorId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
}
