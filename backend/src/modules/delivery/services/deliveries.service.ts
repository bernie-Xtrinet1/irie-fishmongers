import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CustomerAcceptanceStatus,
  Driver,
  Prisma,
  VendorOrderStatus,
} from '@prisma/client';

import { AwaitingCustomerAcceptanceEvent } from '../../../common/events/awaiting-customer-acceptance.event';
import { DeliveryRejectedEvent } from '../../../common/events/delivery-rejected.event';
import { DeliveryStatusUpdatedEvent } from '../../../common/events/delivery-status-updated.event';
import { DriverAssignedEvent } from '../../../common/events/driver-assigned.event';
import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { DriverSettlementEngine } from '../../driver-settlements/services/driver-settlement-engine.service';
import { AssignDeliveryDto } from '../dto/assign-delivery.dto';
import { CustomerAcceptanceDto } from '../dto/customer-acceptance.dto';
import { UpdateDeliveryScheduleDto } from '../dto/update-delivery-schedule.dto';
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
import { closeOpenCompartmentAssignmentsForDelivery } from '../../telemetry/services/telemetry-operations.service';
import { isDeliveryParishEligibleForVendor } from '../parish-service-area.util';
import { DriversRepository } from '../repositories/drivers.repository';
import { RouteHistoryRepository } from '../repositories/route-history.repository';
import { SLABreachesRepository } from '../repositories/sla-breaches.repository';
import {
  AvailableVendorOrder,
  DeliveriesRepository,
  DeliveryWithDetails,
  UpdateDeliveryScheduleInput,
} from '../repositories/deliveries.repository';

@Injectable()
export class DeliveriesService {
  private static txClient(tx: Prisma.TransactionClient): PrismaClientOrTx | undefined {
    return typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function' ? tx : undefined;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly driversRepository: DriversRepository,
    private readonly driverLocationsRepository: DriverLocationsRepository,
    private readonly routeHistoryRepository: RouteHistoryRepository,
    private readonly slaBreachesRepository: SLABreachesRepository,
    private readonly settlementEngine: DriverSettlementEngine,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getAvailable(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedAvailableDeliveriesEntity> {
    await this.getOnlineApprovedDriver(userId);

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
    const precheckDriver = await this.getOnlineApprovedDriver(userId);

    const delivery = await this.prisma.$transaction(async (tx) => {
      const client = DeliveriesService.txClient(tx);
      // Lock driver first, then vendor_order so concurrent claims serialize cleanly without deadlocks.
      await this.driversRepository.lockByIdForUpdate?.(precheckDriver.id, tx);
      const driver = await this.getOnlineApprovedDriver(userId, client);

      const activeCount = await this.deliveriesRepository.countActiveByDriverId(driver.id, client);
      if (activeCount > 0) {
        throw new ConflictException(
          'You already have an active delivery in progress - complete or fail it before claiming another',
        );
      }

      await this.deliveriesRepository.lockVendorOrderForUpdate?.(dto.vendorOrderId, tx);

      const vendorOrder = await this.deliveriesRepository.findVendorOrderForPickup(
        dto.vendorOrderId,
        client,
      );
      if (!vendorOrder) {
        throw new NotFoundException('Vendor order not found');
      }
      if (vendorOrder.status === 'ASSIGNED_TO_DRIVER') {
        throw new ConflictException('This delivery has already been claimed by another driver');
      }
      if (vendorOrder.status !== 'READY_FOR_PICKUP') {
        throw new BadRequestException('This vendor order is not ready for pickup');
      }

      const vendorOrderWithOrder = vendorOrder as AvailableVendorOrder & {
        order?: { deliveryParish?: DeliveryWithDetails['vendorOrder']['order']['deliveryParish']; deliveryZone?: { active?: boolean } | null };
      };
      if (vendorOrderWithOrder.order?.deliveryParish) {
        const parishMapping =
          typeof this.prisma.deliveryZoneParish?.findUnique === 'function'
            ? await this.prisma.deliveryZoneParish.findUnique({
                where: { parish: vendorOrderWithOrder.order.deliveryParish },
                select: { zone: { select: { active: true } } },
              })
            : null;
        const parishMap = parishMapping
          ? new Map([[vendorOrderWithOrder.order.deliveryParish, parishMapping.zone.active]])
          : undefined;
        if (
          !isDeliveryParishEligibleForVendor(
            vendorOrder.vendor,
            vendorOrderWithOrder.order,
            parishMap,
          )
        ) {
          throw new ForbiddenException(
            `Delivery parish ${vendorOrderWithOrder.order.deliveryParish} is outside ${vendorOrder.vendor.businessName}'s configured service parish or delivery zone is inactive`,
          );
        }
      }

      const requiresColdChain = await this.deliveriesRepository.vendorOrderRequiresColdChain(
        dto.vendorOrderId,
        client,
      );
      if (requiresColdChain && !driver.coldChainCapable) {
        throw new ForbiddenException(
          'This delivery contains cold-chain-sensitive seafood and requires a cold-chain-capable driver',
        );
      }

      const existingDelivery = await this.deliveriesRepository.findByVendorOrderId(
        dto.vendorOrderId,
        client,
      );
      if (existingDelivery) {
        throw new ConflictException('This delivery has already been claimed by another driver');
      }

      try {
        const created = await this.deliveriesRepository.create(
          { vendorOrderId: dto.vendorOrderId, driverId: driver.id },
          tx,
        );
        await this.vendorOrdersRepository.updateStatus(dto.vendorOrderId, 'ASSIGNED_TO_DRIVER', tx);
        await this.driversRepository.updateAvailabilityStatus(driver.id, 'BUSY', tx);
        return created;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('This delivery has already been claimed by another driver');
        }
        throw err;
      }
    });

    await this.eventEmitter.emitAsync(
      DriverAssignedEvent.eventName,
      new DriverAssignedEvent(
        delivery.vendorOrder.order.customerId,
        delivery.vendorOrderId,
        delivery.driver.user.firstName,
      ),
    );

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
    const initialDriver = await this.getApprovedDriver(userId);
    const initialDelivery = await this.getOwnedDelivery(initialDriver.id, deliveryId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const client = DeliveriesService.txClient(tx);
      await this.deliveriesRepository.lockDeliveryForUpdate?.(deliveryId, tx);
      const driver = client ? await this.getApprovedDriver(userId, client) : initialDriver;
      const delivery = client
        ? await this.getOwnedDelivery(driver.id, deliveryId, client)
        : initialDelivery;

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
        await this.driversRepository.updateAvailabilityStatus(driver.id, 'ONLINE', tx);
        const delivered = await this.deliveriesRepository.markDelivered(
          delivery.id,
          dto.proofType,
          dto.proofUrl,
          tx,
        );
        // SLA breach detection, path 1 of 2 (see SLABreach's schema
        // comment): a direct consequence of this state transition, so it
        // belongs in the same transaction as the DELIVERED write rather
        // than a separate cron pass. The in-flight-overdue case
        // (OVERDUE_IN_TRANSIT) is handled by SLABreachDetectionService's
        // scheduled scan instead, since it can't be caught by any state
        // transition.
        if (
          delivery.customerDeliveryWindowEnd &&
          (delivered.deliveredAt as Date) > delivery.customerDeliveryWindowEnd
        ) {
          await this.slaBreachesRepository.upsert(
            {
              deliveryId: delivery.id,
              type: 'LATE_DELIVERY',
              scheduledEnd: delivery.customerDeliveryWindowEnd,
              minutesLate: Math.round(
                ((delivered.deliveredAt as Date).getTime() -
                  delivery.customerDeliveryWindowEnd.getTime()) /
                  60_000,
              ),
            },
            tx,
          );
        }
        await closeOpenCompartmentAssignmentsForDelivery(
          tx,
          delivery.id,
          delivered.deliveredAt as Date,
          {
            markRemainingAsHandedOver: true,
            actorUserId: userId,
            reason: 'Delivery marked DELIVERED; closed open compartment telemetry assignments',
          },
        );
        const routeHistory = await this.recordRouteHistory(
          delivery,
          delivered.deliveredAt as Date,
          tx,
        );
        return { ...delivered, routeHistory };
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
      await this.driversRepository.updateAvailabilityStatus(driver.id, 'ONLINE', tx);
      const failed = await this.deliveriesRepository.markFailed(delivery.id, dto.failureReason, tx);
      await closeOpenCompartmentAssignmentsForDelivery(
        tx,
        delivery.id,
        failed.failedAt as Date,
        {
          markRemainingAsHandedOver: false,
          actorUserId: userId,
          reason: `Delivery marked FAILED: ${dto.failureReason}`,
        },
      );
      const routeHistory = await this.recordRouteHistory(delivery, failed.failedAt as Date, tx);
      return { ...failed, routeHistory };
    });

    await this.eventEmitter.emitAsync(
      DeliveryStatusUpdatedEvent.eventName,
      new DeliveryStatusUpdatedEvent(
        updated.vendorOrder.order.customerId,
        updated.vendorOrderId,
        DeliveriesService.computeStage(updated),
      ),
    );

    if (dto.action === 'DELIVERED') {
      await this.eventEmitter.emitAsync(
        AwaitingCustomerAcceptanceEvent.eventName,
        new AwaitingCustomerAcceptanceEvent(
          updated.vendorOrder.order.customerId,
          updated.vendorOrderId,
        ),
      );
    }

    return DeliveriesService.toDriverResponse(updated);
  }

  async updateSchedule(
    userId: string,
    deliveryId: string,
    dto: UpdateDeliveryScheduleDto,
  ): Promise<DriverDeliveryResponseEntity> {
    const driver = await this.getApprovedDriver(userId);
    const delivery = await this.getOwnedDelivery(driver.id, deliveryId);
    this.assertOpenForTransition(delivery);

    const input: UpdateDeliveryScheduleInput = {
      scheduledPickupWindowStart: dto.scheduledPickupWindowStart
        ? new Date(dto.scheduledPickupWindowStart)
        : undefined,
      scheduledPickupWindowEnd: dto.scheduledPickupWindowEnd
        ? new Date(dto.scheduledPickupWindowEnd)
        : undefined,
      customerDeliveryWindowStart: dto.customerDeliveryWindowStart
        ? new Date(dto.customerDeliveryWindowStart)
        : undefined,
      customerDeliveryWindowEnd: dto.customerDeliveryWindowEnd
        ? new Date(dto.customerDeliveryWindowEnd)
        : undefined,
    };

    const pickupStart = input.scheduledPickupWindowStart ?? delivery.scheduledPickupWindowStart;
    const pickupEnd = input.scheduledPickupWindowEnd ?? delivery.scheduledPickupWindowEnd;
    if (pickupStart && pickupEnd && pickupEnd <= pickupStart) {
      throw new BadRequestException('Pickup window end must be after the window start');
    }

    const deliveryStart = input.customerDeliveryWindowStart ?? delivery.customerDeliveryWindowStart;
    const deliveryEnd = input.customerDeliveryWindowEnd ?? delivery.customerDeliveryWindowEnd;
    if (deliveryStart && deliveryEnd && deliveryEnd <= deliveryStart) {
      throw new BadRequestException('Delivery window end must be after the window start');
    }

    const updated = await this.deliveriesRepository.updateSchedule(delivery.id, input);
    return DeliveriesService.toDriverResponse(updated);
  }

  async confirmVendorPickup(userId: string, deliveryId: string): Promise<DriverDeliveryResponseEntity> {
    const delivery = await this.deliveriesRepository.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }
    if (delivery.vendorOrder.vendor.userId !== userId) {
      throw new ForbiddenException('You do not own this delivery');
    }
    this.assertOpenForTransition(delivery);

    const updated = await this.deliveriesRepository.confirmVendorPickup(delivery.id, userId);
    return DeliveriesService.toDriverResponse(updated);
  }

  async recordCustomerAcceptance(
    userId: string,
    deliveryId: string,
    dto: CustomerAcceptanceDto,
  ): Promise<DriverDeliveryResponseEntity> {
    const delivery = await this.deliveriesRepository.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }
    if (delivery.vendorOrder.order.customerId !== userId) {
      throw new ForbiddenException('You do not have access to this delivery');
    }
    if (!delivery.deliveredAt) {
      throw new BadRequestException('This delivery has not been marked delivered yet');
    }
    if (delivery.customerAcceptanceStatus !== 'PENDING') {
      throw new BadRequestException('This delivery has already been accepted or rejected');
    }
    if (dto.decision === 'REJECTED' && !dto.reason) {
      throw new BadRequestException('A reason is required when rejecting a delivery');
    }

    const updated = await this.deliveriesRepository.recordCustomerAcceptance(delivery.id, {
      customerAcceptanceStatus: dto.decision,
      customerAcceptedAt: dto.decision === 'ACCEPTED' ? new Date() : undefined,
      customerRejectedAt: dto.decision === 'REJECTED' ? new Date() : undefined,
      rejectionReason: dto.decision === 'REJECTED' ? dto.reason : undefined,
    });

    if (dto.decision === 'REJECTED') {
      await this.eventEmitter.emitAsync(
        DeliveryRejectedEvent.eventName,
        new DeliveryRejectedEvent(
          userId,
          delivery.vendorOrderId,
          dto.reason as string,
          delivery.vendorOrder.vendor.userId,
        ),
      );
    }

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

    const stage = DeliveriesService.computeStage(delivery);
    const locationStopped =
      delivery.deliveredAt !== null ||
      delivery.failedAt !== null ||
      delivery.customerRejectedAt !== null ||
      delivery.customerAcceptanceStatus === CustomerAcceptanceStatus.REJECTED ||
      delivery.vendorOrder.status === VendorOrderStatus.CANCELLED ||
      delivery.vendorOrder.status === VendorOrderStatus.REJECTED ||
      delivery.vendorOrder.status === VendorOrderStatus.DELIVERED ||
      delivery.vendorOrder.status === VendorOrderStatus.DELIVERY_FAILED;
    // Privacy gate: customers may only see live location while their order is actively on board.
    if (stage !== 'PICKED_UP' || locationStopped) {
      return DeliveriesService.toTrackingEntity(delivery, null);
    }

    const [driverLocation, telemetryLocation] = await Promise.all([
      this.driverLocationsRepository.findLatestByDriverId(delivery.driverId),
      typeof this.deliveriesRepository.findActiveFleetLocationForDelivery === 'function'
        ? this.deliveriesRepository.findActiveFleetLocationForDelivery(delivery.id)
        : Promise.resolve(null),
    ]);

    let latestPoint: { latitude: number; longitude: number; recordedAt: Date } | null = null;
    if (driverLocation && telemetryLocation) {
      latestPoint =
        telemetryLocation.recordedAt.getTime() >= driverLocation.recordedAt.getTime()
          ? telemetryLocation
          : driverLocation;
    } else {
      latestPoint = telemetryLocation ?? driverLocation;
    }

    return DeliveriesService.toTrackingEntity(delivery, latestPoint);
  }

  private assertOpenForTransition(delivery: DeliveryWithDetails): void {
    if (delivery.deliveredAt || delivery.failedAt) {
      throw new BadRequestException('This delivery has already been delivered or marked failed');
    }
  }

  private async recordRouteHistory(
    delivery: DeliveryWithDetails,
    terminalAt: Date,
    tx: Prisma.TransactionClient,
  ) {
    const startAt = delivery.pickedUpAt ?? delivery.assignedAt;
    const locations = await this.driverLocationsRepository.findBetween(
      delivery.driverId,
      startAt,
      terminalAt,
    );
    const distanceKm = this.settlementEngine.computeDistanceKm(locations);
    const durationMinutes = Math.round((terminalAt.getTime() - startAt.getTime()) / 60_000);

    return this.routeHistoryRepository.create(
      {
        deliveryId: delivery.id,
        driverId: delivery.driverId,
        gpsSamples: locations.length,
        distanceKm,
        durationMinutes,
      },
      tx,
    );
  }

  private async getOwnedDelivery(
    driverId: string,
    deliveryId: string,
    client?: PrismaClientOrTx,
  ): Promise<DeliveryWithDetails> {
    const delivery = await this.deliveriesRepository.findById(deliveryId, client);
    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }
    if (delivery.driverId !== driverId) {
      throw new ForbiddenException('You do not own this delivery');
    }
    return delivery;
  }

  private async getApprovedDriver(userId: string, client?: PrismaClientOrTx): Promise<Driver> {
    const driver = await this.getOwnDriver(userId, client);
    if (driver.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved drivers can perform this action');
    }
    return driver;
  }

  private async getOnlineApprovedDriver(
    userId: string,
    client?: PrismaClientOrTx,
  ): Promise<Driver> {
    const driver = await this.getApprovedDriver(userId, client);
    if (driver.availabilityStatus !== 'ONLINE') {
      throw new ForbiddenException('You must be online to do this - update your availability first');
    }
    return driver;
  }

  private async getOwnDriver(userId: string, client?: PrismaClientOrTx): Promise<Driver> {
    const driver = await this.driversRepository.findByUserId(userId, client);
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

  private static mapDeliveryItemSummary(
    item: AvailableVendorOrder['items'][number] | DeliveryWithDetails['vendorOrder']['items'][number],
  ) {
    const withLot = item as typeof item & {
      originalLotId?: string | null;
      originalLot?: { id: string; lotNumber: string; species: string; storageType: string } | null;
      product?: {
        lotId?: string | null;
        lot?: { id: string; lotNumber: string; species: string; storageType: string } | null;
      } | null;
    };
    const lot = withLot.originalLot ?? withLot.product?.lot ?? null;
    return {
      productName: item.productName,
      unit: item.unit,
      quantity: item.quantity,
      lotId: lot?.id ?? withLot.originalLotId ?? withLot.product?.lotId ?? null,
      lotNumber: lot?.lotNumber ?? null,
      species: lot?.species ?? null,
      storageType: lot?.storageType ?? null,
    };
  }

  private static toAvailableEntity(vendorOrder: AvailableVendorOrder): AvailableDeliveryEntity {
    return {
      vendorOrderId: vendorOrder.id,
      pickupVendorName: vendorOrder.vendor.businessName,
      pickupParish: vendorOrder.vendor.parish,
      items: vendorOrder.items.map((item) => DeliveriesService.mapDeliveryItemSummary(item)),
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
      items: delivery.vendorOrder.items.map((item) => DeliveriesService.mapDeliveryItemSummary(item)),
      deliveryAddressLine1: delivery.vendorOrder.order.deliveryAddressLine1,
      deliveryAddressLine2: delivery.vendorOrder.order.deliveryAddressLine2,
      deliveryParish: delivery.vendorOrder.order.deliveryParish,
      deliveryPhone: delivery.vendorOrder.order.deliveryPhone,
      scheduledPickupWindowStart: delivery.scheduledPickupWindowStart,
      scheduledPickupWindowEnd: delivery.scheduledPickupWindowEnd,
      customerDeliveryWindowStart: delivery.customerDeliveryWindowStart,
      customerDeliveryWindowEnd: delivery.customerDeliveryWindowEnd,
      vendorConfirmedAt: delivery.vendorConfirmedAt,
      vendorConfirmedById: delivery.vendorConfirmedById,
      customerAcceptanceStatus: delivery.customerAcceptanceStatus,
      customerAcceptedAt: delivery.customerAcceptedAt,
      customerRejectedAt: delivery.customerRejectedAt,
      rejectionReason: delivery.rejectionReason,
      assignedAt: delivery.assignedAt,
      pickedUpAt: delivery.pickedUpAt,
      deliveredAt: delivery.deliveredAt,
      failedAt: delivery.failedAt,
      failureReason: delivery.failureReason,
      proofType: delivery.proofType,
      proofUrl: delivery.proofUrl,
      exceptions: delivery.exceptions.map((exception) => ({
        id: exception.id,
        deliveryId: exception.deliveryId,
        type: exception.type,
        reason: exception.reason,
        photos: exception.photos,
        notes: exception.notes,
        resolved: exception.resolved,
        resolvedAt: exception.resolvedAt,
        resolvedById: exception.resolvedById,
        createdAt: exception.createdAt,
      })),
      routeHistory: delivery.routeHistory
        ? {
            id: delivery.routeHistory.id,
            deliveryId: delivery.routeHistory.deliveryId,
            driverId: delivery.routeHistory.driverId,
            gpsSamples: delivery.routeHistory.gpsSamples,
            distanceKm: delivery.routeHistory.distanceKm,
            durationMinutes: delivery.routeHistory.durationMinutes,
            createdAt: delivery.routeHistory.createdAt,
          }
        : null,
    };
  }

  private static toTrackingEntity(
    delivery: DeliveryWithDetails,
    latestLocation: { latitude: number; longitude: number; recordedAt: Date } | null,
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
      customerDeliveryWindowStart: delivery.customerDeliveryWindowStart,
      customerDeliveryWindowEnd: delivery.customerDeliveryWindowEnd,
      assignedAt: delivery.assignedAt,
      pickedUpAt: delivery.pickedUpAt,
      deliveredAt: delivery.deliveredAt,
      failedAt: delivery.failedAt,
    };
  }
}
