import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Vendor, VendorStatus } from '@prisma/client';

import { ListVendorsDto } from '../dto/list-vendors.dto';
import { RegisterVendorDto } from '../dto/register-vendor.dto';
import { UpdateVendorProfileDto } from '../dto/update-vendor-profile.dto';
import { VendorPublicEntity } from '../entities/vendor-public.entity';
import { VendorsRepository } from '../repositories/vendors.repository';

export interface PaginatedVendors {
  items: Vendor[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class VendorsService {
  constructor(private readonly vendorsRepository: VendorsRepository) {}

  async register(userId: string, dto: RegisterVendorDto): Promise<Vendor> {
    const existing = await this.vendorsRepository.findByUserId(userId);
    if (existing) {
      throw new ConflictException('A vendor profile already exists for this account');
    }

    return this.vendorsRepository.create({
      userId,
      businessName: dto.businessName,
      parish: dto.parish,
      phone: dto.phone,
      description: dto.description,
      termsAcceptedAt: new Date(),
    });
  }

  async getOwnProfile(userId: string): Promise<Vendor> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return vendor;
  }

  async updateOwnProfile(userId: string, dto: UpdateVendorProfileDto): Promise<Vendor> {
    const vendor = await this.getOwnProfile(userId);
    return this.vendorsRepository.update(vendor.id, dto);
  }

  async getPublicProfile(id: string): Promise<VendorPublicEntity> {
    const vendor = await this.vendorsRepository.findById(id);
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new NotFoundException('Vendor not found');
    }

    return {
      id: vendor.id,
      businessName: vendor.businessName,
      description: vendor.description,
      parish: vendor.parish,
      logoUrl: vendor.logoUrl,
    };
  }

  async updateStatus(vendorId: string, status: VendorStatus): Promise<Vendor> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    return this.vendorsRepository.updateStatus(vendorId, status);
  }

  async list(dto: ListVendorsDto): Promise<PaginatedVendors> {
    const { items, total } = await this.vendorsRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }
}
