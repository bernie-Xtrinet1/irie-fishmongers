import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Driver, DriverStatus } from '@prisma/client';

import { ListDriversDto } from '../dto/list-drivers.dto';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';

export interface PaginatedDrivers {
  items: Driver[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class DriversService {
  constructor(
    private readonly driversRepository: DriversRepository,
    private readonly driverLocationsRepository: DriverLocationsRepository,
  ) {}

  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.driversRepository.findByUserId(userId);
    if (existing) {
      throw new ConflictException('A driver profile already exists for this account');
    }

    return this.driversRepository.create({
      userId,
      licensePlate: dto.licensePlate,
      vehicleType: dto.vehicleType,
      vehicleOwnership: dto.vehicleOwnership,
    });
  }

  async getOwnProfile(userId: string): Promise<Driver> {
    const driver = await this.driversRepository.findByUserId(userId);
    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account');
    }
    return driver;
  }

  async updateStatus(driverId: string, status: DriverStatus): Promise<Driver> {
    const driver = await this.driversRepository.findById(driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }
    return this.driversRepository.updateStatus(driverId, status);
  }

  async list(dto: ListDriversDto): Promise<PaginatedDrivers> {
    const { items, total } = await this.driversRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  async recordLocation(userId: string, latitude: number, longitude: number): Promise<void> {
    const driver = await this.getOwnProfile(userId);
    if (driver.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved drivers can report their location');
    }
    await this.driverLocationsRepository.record(driver.id, latitude, longitude);
  }
}
