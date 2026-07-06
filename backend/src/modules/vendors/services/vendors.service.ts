import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Vendor, VendorStatus } from '@prisma/client';

import { RegisterVendorDto } from '../dto/register-vendor.dto';
import { VendorsRepository } from '../repositories/vendors.repository';

@Injectable()
export class VendorsService {
  constructor(private readonly vendorsRepository: VendorsRepository) {}

  async register(userId: string, dto: RegisterVendorDto): Promise<Vendor> {
    const existing = await this.vendorsRepository.findByUserId(userId);
    if (existing) {
      throw new ConflictException('A vendor profile already exists for this account');
    }

    return this.vendorsRepository.create({ userId, businessName: dto.businessName });
  }

  async getOwnProfile(userId: string): Promise<Vendor> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return vendor;
  }

  async updateStatus(vendorId: string, status: VendorStatus): Promise<Vendor> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    return this.vendorsRepository.updateStatus(vendorId, status);
  }
}
