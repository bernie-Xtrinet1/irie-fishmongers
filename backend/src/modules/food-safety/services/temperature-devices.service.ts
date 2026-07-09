import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TemperatureDevice } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { RegisterTemperatureDeviceDto } from '../dto/register-temperature-device.dto';
import { TemperatureDeviceResponseEntity } from '../entities/temperature-device-response.entity';
import { TemperatureDevicesRepository } from '../repositories/temperature-devices.repository';

// A device with no reading in the last hour is considered offline -
// computed on read, not a stored/scheduled state, matching this codebase's
// established no-scheduler-exists precedent elsewhere.
const OFFLINE_AFTER_MS = 60 * 60 * 1000;

@Injectable()
export class TemperatureDevicesService {
  constructor(
    private readonly devicesRepository: TemperatureDevicesRepository,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async register(userId: string, dto: RegisterTemperatureDeviceDto): Promise<TemperatureDeviceResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors can register temperature devices');
    }

    const existing = await this.devicesRepository.findByDeviceCode(dto.deviceCode);
    if (existing) {
      throw new ConflictException(`A device with code "${dto.deviceCode}" already exists`);
    }

    const device = await this.devicesRepository.create({ vendorId: vendor.id, deviceCode: dto.deviceCode });
    return TemperatureDevicesService.toResponse(device);
  }

  async getMine(userId: string): Promise<TemperatureDeviceResponseEntity[]> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    const devices = await this.devicesRepository.findMany(vendor.id);
    return devices.map((device) => TemperatureDevicesService.toResponse(device));
  }

  async list(vendorId?: string): Promise<TemperatureDeviceResponseEntity[]> {
    const devices = await this.devicesRepository.findMany(vendorId);
    return devices.map((device) => TemperatureDevicesService.toResponse(device));
  }

  private static toResponse(device: TemperatureDevice): TemperatureDeviceResponseEntity {
    return {
      id: device.id,
      vendorId: device.vendorId,
      deviceCode: device.deviceCode,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      isOffline:
        device.status !== 'DECOMMISSIONED' &&
        (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > OFFLINE_AFTER_MS),
      createdAt: device.createdAt,
    };
  }
}
