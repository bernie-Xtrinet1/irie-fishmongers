import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Driver, DriverLocation } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { AssignDeliveryDto } from '../dto/assign-delivery.dto';
import { UpdateDeliveryStatusDto } from '../dto/update-delivery-status.dto';
import { AvailableDeliveryEntity } from '../entities/available-delivery.entity';
import { DeliveryTrackingEntity } from '../entities/delivery-tracking.entity';
import {
  DeliveryStage,
  DriverDeliveryResponseEntity,
} from '../entities/driver-delivery-response.entity';
import { PaginatedAvailableDeliveriesEntity } from '../entities/paginated-available-deliveries.entity';
import { PaginatedDriverDeliveriesEntity } from '../entities/paginated-driver-deliveries.entity';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import {
  AvailableVendorOrder,
  DeliveriesRepository,
  DeliveryWithDetails,
} from '../repositories/deliveries.repository';

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly driversRepository: DriversRepository,
    private readonly driverLocationsRepository: DriverLocationsRepository,
  ) {}

  async getAvailable(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedAvailableDeliveriesEntity> {
    await this.getApprovedDriver(userId);

    const { items, total } = await this.deliveriesRepository.findAvailableForPickup({
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => DeliveriesService.toAvailableEntity(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async assign(userId: string, dto: AssignDeliveryDto): Promise<DriverDeliveryResponseEntity> {
    const driver = await this.getApprovedDriver(userId);

    const activeCount = await this.deliveriesRepository.countActiveByDriverId(driver.id);
    if (activeCount > 0) {
      throw new ConflictException(
        'You already have an active delivery in progress - complete or fail it before claiming another',
      );
    }

    const vendorOrder = await this.deliveriesRepository.findVendorOrderForPickup(
      dto.vendorOrderId,
    );
    if (!vendorOrder) {
      throw new NotFoundException('Vendor order not found');
    }
    if (vendorOrder.status !== 'READY_FOR_PICKUP') {
      throw new BadRequestException('This vendor order is not ready for pickup');
    }

    const existingDelivery = await this.deliveriesRepository.findByVendorOrderId(
      dto.vendorOrderId,
    );
    if (existingDelivery) {
      throw new ConflictException('This delivery has already been claimed by another driver');
    }

    const delivery = await this.prisma.$transaction(async (tx) => {
      const created = await this.deliveriesRepository.create(
        { vendorOrderId: dto.vendorOrderId, driverId: driver.id },
        tx,
      );
      await this.vendorOrdersRepository.updateStatus(dto.vendorOrderId, 'ASSIGNED_TO_DRIVER', tx);
      return created;
    });

    return DeliveriesService.toDriverResponse(delivery);
  }

  async getMine(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedDriverDeliveriesEntity> {
    const driver = await this.getOwnDriver(userId);

    const { items, total } = await this.deliveriesRepository.findManyByDriver(driver.id, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => DeliveriesService.toDriverResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async updateStatus(
    userId: string,
    deliveryId: string,
    dto: UpdateDeliveryStatusDto,
  ): Promise<DriverDeliveryResponseEntity> {
    const driver = await this.getApprovedDriver(userId);
    const delivery = await this.getOwnedDelivery(driver.id, deliveryId);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.action === 'PICKED_UP') {
        this.assertOpenForTransition(delivery);
        if (delivery.pickedUpAt) {
          throw new BadRequestException('This delivery has already been picked up');
        }
        await this.vendorOrdersRepository.updateStatus(delivery.vendorOrderId, 'IN_TRANSIT', tx);
        return this.deliveriesRepository.markPickedUp(delivery.id, tx);
      }

      if (dto.action === 'DELIVERED') {
        this.assertOpenForTransition(delivery);
        if (!delivery.pickedUpAt) {
          throw new BadRequestException(
            'This delivery must be picked up before it can be marked delivered',
          );
        }
        if (!dto.proofType || !dto.proofUrl) {
          throw new BadRequestException('Proof of delivery (type and url) is required');
        }
        await this.vendorOrdersRepository.updateStatus(delivery.vendorOrderId, 'DELIVERED', tx);
        return this.deliveriesRepository.markDelivered(
          delivery.id,
          dto.proofType,
          dto.proofUrl,
          tx,
        );
      }

      this.assertOpenForTransition(delivery);
      if (!dto.failureReason) {
        throw new BadRequestException('A failure reason is required');
      }
      await this.vendorOrdersRepository.updateStatus(
        delivery.vendorOrderId,
        'DELIVERY_FAILED',
        tx,
      );
      return this.deliveriesRepository.markFailed(delivery.id, dto.failureReason, tx);
    });

    return DeliveriesService.toDriverResponse(updated);
  }

  async track(userId: string, vendorOrderId: string): Promise<DeliveryTrackingEntity> {
    const delivery = await this.deliveriesRepository.findByVendorOrderId(vendorOrderId);
    if (!delivery) {
      throw new NotFoundException('This order has not yet been assigned to a driver');
    }
    if (delivery.vendorOrder.order.customerId !== userId) {
      throw new ForbiddenException('You do not have access to this delivery');
    }

    const latestLocation = await this.driverLocationsRepository.findLatestByDriverId(
      delivery.driverId,
    );

    return DeliveriesService.toTrackingEntity(delivery, latestLocation);
  }

  private assertOpenForTransition(delivery: DeliveryWithDetails): void {
    if (delivery.deliveredAt || delivery.failedAt) {
      throw new BadRequestException('This delivery has already been delivered or marked failed');
    }
  }

  private async getOwnedDelivery(driverId: string, deliveryId: string): Promise<DeliveryWithDetails> {
    const delivery = await this.deliveriesRepository.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }
    if (delivery.driverId !== driverId) {
      throw new ForbiddenException('You do not own this delivery');
    }
    return delivery;
  }

  private async getApprovedDriver(userId: string): Promise<Driver> {
    const driver = await this.getOwnDriver(userId);
    if (driver.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved drivers can perform this action');
    }
    return driver;
  }

  private async getOwnDriver(userId: string): Promise<Driver> {
    const driver = await this.driversRepository.findByUserId(userId);
    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account');
    }
    return driver;
  }

  private static computeStage(delivery: {
    pickedUpAt: Date | null;
    deliveredAt: Date | null;
    failedAt: Date | null;
  }): DeliveryStage {
    if (delivery.failedAt) return 'FAILED';
    if (delivery.deliveredAt) return 'DELIVERED';
    if (delivery.pickedUpAt) return 'PICKED_UP';
    return 'ASSIGNED';
  }

  private static toAvailableEntity(vendorOrder: AvailableVendorOrder): AvailableDeliveryEntity {
    return {
      vendorOrderId: vendorOrder.id,
      pickupVendorName: vendorOrder.vendor.businessName,
      pickupParish: vendorOrder.vendor.parish,
      items: vendorOrder.items.map((item) => ({
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
      })),
      readyForPickupAt: vendorOrder.updatedAt,
    };
  }

  private static toDriverResponse(delivery: DeliveryWithDetails): DriverDeliveryResponseEntity {
    return {
      id: delivery.id,
      vendorOrderId: delivery.vendorOrderId,
      driverId: delivery.driverId,
      stage: DeliveriesService.computeStage(delivery),
      pickupVendorName: delivery.vendorOrder.vendor.businessName,
      pickupParish: delivery.vendorOrder.vendor.parish,
      items: delivery.vendorOrder.items.map((item) => ({
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
      })),
      deliveryAddressLine1: delivery.vendorOrder.order.deliveryAddressLine1,
      deliveryAddressLine2: delivery.vendorOrder.order.deliveryAddressLine2,
      deliveryParish: delivery.vendorOrder.order.deliveryParish,
      deliveryPhone: delivery.vendorOrder.order.deliveryPhone,
      assignedAt: delivery.assignedAt,
      pickedUpAt: delivery.pickedUpAt,
      deliveredAt: delivery.deliveredAt,
      failedAt: delivery.failedAt,
      failureReason: delivery.failureReason,
      proofType: delivery.proofType,
      proofUrl: delivery.proofUrl,
    };
  }

  private static toTrackingEntity(
    delivery: DeliveryWithDetails,
    latestLocation: DriverLocation | null,
  ): DeliveryTrackingEntity {
    return {
      vendorOrderId: delivery.vendorOrderId,
      stage: DeliveriesService.computeStage(delivery),
      driverFirstName: delivery.driver.user.firstName,
      driverPhone: delivery.driver.user.phone,
      driverVehicleType: delivery.driver.vehicleType,
      driverLicensePlate: delivery.driver.licensePlate,
      latestLocation: latestLocation
        ? {
            latitude: latestLocation.latitude,
            longitude: latestLocation.longitude,
            recordedAt: latestLocation.recordedAt,
          }
        : null,
      assignedAt: delivery.assignedAt,
      pickedUpAt: delivery.pickedUpAt,
      deliveredAt: delivery.deliveredAt,
      failedAt: delivery.failedAt,
    };
  }
}
