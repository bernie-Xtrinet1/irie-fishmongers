import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryException } from '@prisma/client';

import { CreateDeliveryExceptionDto } from '../dto/create-delivery-exception.dto';
import { ListDeliveryExceptionsDto } from '../dto/list-delivery-exceptions.dto';
import { DeliveryExceptionWithContextEntity } from '../entities/delivery-exception-with-context.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import {
  DeliveryExceptionsRepository,
  DeliveryExceptionWithContext,
} from '../repositories/delivery-exceptions.repository';
import { DriversRepository } from '../repositories/drivers.repository';

export interface PaginatedDeliveryExceptionsWithContext {
  items: DeliveryExceptionWithContextEntity[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class DeliveryExceptionsService {
  constructor(
    private readonly exceptionsRepository: DeliveryExceptionsRepository,
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly driversRepository: DriversRepository,
  ) {}

  async create(
    userId: string,
    deliveryId: string,
    dto: CreateDeliveryExceptionDto,
  ): Promise<DeliveryException> {
    const driver = await this.driversRepository.findByUserId(userId);
    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account');
    }

    const delivery = await this.deliveriesRepository.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }
    if (delivery.driverId !== driver.id) {
      throw new ForbiddenException('You do not own this delivery');
    }
    if (delivery.deliveredAt || delivery.failedAt) {
      throw new BadRequestException('This delivery has already been delivered or marked failed');
    }

    return this.exceptionsRepository.create({
      deliveryId,
      type: dto.type,
      reason: dto.reason,
      photos: dto.photos ?? [],
      notes: dto.notes,
    });
  }

  async resolve(id: string, resolvedById: string): Promise<DeliveryException> {
    const exception = await this.exceptionsRepository.findById(id);
    if (!exception) {
      throw new NotFoundException('Delivery exception not found');
    }
    if (exception.resolved) {
      throw new BadRequestException('This exception has already been resolved');
    }
    return this.exceptionsRepository.resolve(id, resolvedById);
  }

  async list(dto: ListDeliveryExceptionsDto): Promise<PaginatedDeliveryExceptionsWithContext> {
    const { items, total } = await this.exceptionsRepository.findManyWithContext(dto.resolved, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return {
      items: items.map((exception) => DeliveryExceptionsService.toContextEntity(exception)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  private static toContextEntity(
    exception: DeliveryExceptionWithContext,
  ): DeliveryExceptionWithContextEntity {
    const { delivery } = exception;
    const { vendorOrder } = delivery;

    return {
      id: exception.id,
      deliveryId: exception.deliveryId,
      vendorOrderId: vendorOrder.id,
      type: exception.type,
      reason: exception.reason,
      photos: exception.photos,
      notes: exception.notes,
      resolved: exception.resolved,
      resolvedAt: exception.resolvedAt,
      resolvedById: exception.resolvedById,
      vendorBusinessName: vendorOrder.vendor.businessName,
      customerName: `${vendorOrder.order.customer.firstName} ${vendorOrder.order.customer.lastName}`,
      deliveryAddressLine1: vendorOrder.order.deliveryAddressLine1,
      deliveryParish: vendorOrder.order.deliveryParish,
      driverName: `${delivery.driver.user.firstName} ${delivery.driver.user.lastName}`,
      createdAt: exception.createdAt,
    };
  }
}
