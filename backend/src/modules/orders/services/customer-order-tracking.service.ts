import { ForbiddenException, Injectable } from '@nestjs/common';
import { CustomerAcceptanceStatus, VendorOrderStatus } from '@prisma/client';

import {
  computeVehicleGpsStatus,
  STALE_TELEMETRY_THRESHOLD_MS,
} from '../../telemetry/telemetry-status.util';
import {
  CustomerDeliveryTrackingStage,
  CustomerTrackedDeliveryPartEntity,
  CustomerTrackedLocationEntity,
  CustomerTrackedLocationStatus,
  OrderDeliveryTrackingEntity,
} from '../entities/order-delivery-tracking.entity';
import { OrdersRepository, OrderTrackingRecord } from '../repositories/orders.repository';

type VendorOrderTrackingRecord = OrderTrackingRecord['vendorOrders'][number];
type TrackedVehicleGps = NonNullable<
  NonNullable<VendorOrderTrackingRecord['cargoAssignments'][number]>['fleetAsset']
>;

const TERMINAL_STAGE_LABELS: Record<
  Exclude<CustomerDeliveryTrackingStage, 'AWAITING_PICKUP' | 'IN_TRANSIT'>,
  { statusLabel: string; locationMessage: string }
> = {
  HANDED_OVER: {
    statusLabel: 'Handed over',
    locationMessage: 'Vehicle location sharing ended after order handover.',
  },
  DELIVERED: {
    statusLabel: 'Delivered',
    locationMessage: 'Vehicle location sharing ended when your delivery was completed.',
  },
  RETURNED: {
    statusLabel: 'Returned',
    locationMessage: 'Vehicle location sharing ended because this delivery was returned.',
  },
  CANCELLED: {
    statusLabel: 'Cancelled',
    locationMessage: 'Vehicle location sharing is unavailable for a cancelled delivery.',
  },
  FAILED: {
    statusLabel: 'Delivery failed',
    locationMessage: 'Vehicle location sharing ended when this delivery was marked failed.',
  },
};

/**
 * Serves privacy-preserving, ownership-verified live delivery tracking for customers.
 */
@Injectable()
export class CustomerOrderTrackingService {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  /**
   * Returns per-delivery customer tracking for an order owned by the requesting customer.
   */
  async getOrderTracking(
    customerId: string,
    orderId: string,
    now = new Date(),
  ): Promise<OrderDeliveryTrackingEntity> {
    const order = await this.ordersRepository.findOrderTrackingById(orderId);
    if (!order || order.customerId !== customerId) {
      throw new ForbiddenException('You do not have access to this order');
    }

    const totalDeliveries = order.vendorOrders.length;
    const deliveries = order.vendorOrders.map((vendorOrder, index) =>
      this.toTrackedDeliveryPart(vendorOrder, index + 1, totalDeliveries, now),
    );

    return {
      orderId: order.id,
      deliveryParish: order.deliveryParish,
      isSplitOrder: totalDeliveries > 1,
      hasActiveTracking: deliveries.some((delivery) => delivery.stage === 'IN_TRANSIT'),
      deliveries,
      checkedAt: now.toISOString(),
    };
  }

  private toTrackedDeliveryPart(
    vendorOrder: VendorOrderTrackingRecord,
    deliveryIndex: number,
    totalDeliveries: number,
    now: Date,
  ): CustomerTrackedDeliveryPartEntity {
    const vendorName = vendorOrder.vendor.businessName;
    const deliveryLabel =
      totalDeliveries > 1
        ? `Part ${deliveryIndex} of ${totalDeliveries} · ${vendorName}`
        : vendorName;

    const items = vendorOrder.items.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
    }));
    const itemsSummary = items
      .map((item) => `${item.quantity}x ${item.productName}`)
      .join(', ');

    const basePart = {
      vendorOrderId: vendorOrder.id,
      deliveryIndex,
      totalDeliveries,
      deliveryLabel,
      vendorName,
      itemsSummary,
      items,
      vendorStatus: vendorOrder.status,
      pickedUpAt: vendorOrder.delivery?.pickedUpAt?.toISOString() ?? null,
      customerDeliveryWindowStart:
        vendorOrder.delivery?.customerDeliveryWindowStart?.toISOString() ?? null,
      customerDeliveryWindowEnd:
        vendorOrder.delivery?.customerDeliveryWindowEnd?.toISOString() ?? null,
    };

    const stage = this.resolveStage(vendorOrder);
    if (stage !== 'IN_TRANSIT') {
      return this.buildInactivePart(basePart, stage, vendorOrder.status);
    }

    const vehicle = this.resolveOnBoardVehicle(vendorOrder);
    const { locationStatus, locationMessage, location } = this.evaluateVehicleLocation(
      vehicle,
      now,
    );

    return {
      ...basePart,
      stage: 'IN_TRANSIT',
      statusLabel: 'Picked up / In transit',
      onBoard: true,
      isLocationShared: location !== null,
      locationStatus,
      locationMessage,
      location,
    };
  }

  private resolveStage(vendorOrder: VendorOrderTrackingRecord): CustomerDeliveryTrackingStage {
    const delivery = vendorOrder.delivery;

    if (
      vendorOrder.status === VendorOrderStatus.CANCELLED ||
      vendorOrder.status === VendorOrderStatus.REJECTED
    ) {
      return 'CANCELLED';
    }

    if (
      delivery?.customerAcceptanceStatus === CustomerAcceptanceStatus.REJECTED ||
      delivery?.customerRejectedAt !== null && delivery?.customerRejectedAt !== undefined
    ) {
      return 'RETURNED';
    }

    if (
      vendorOrder.status === VendorOrderStatus.DELIVERY_FAILED ||
      delivery?.failedAt !== null && delivery?.failedAt !== undefined
    ) {
      return 'FAILED';
    }

    if (
      vendorOrder.status === VendorOrderStatus.DELIVERED ||
      delivery?.deliveredAt !== null && delivery?.deliveredAt !== undefined
    ) {
      return 'DELIVERED';
    }

    // Stop sharing immediately once all assigned cargo compartments for this vendor order
    // are unloaded/handed over, even while the vehicle continues to subsequent route stops.
    const cargoAssignments = vendorOrder.cargoAssignments;
    if (
      cargoAssignments.length > 0 &&
      cargoAssignments.every(
        (assignment) =>
          assignment.unloadedAt !== null ||
          assignment.handedOverQuantity >= assignment.quantityUnits,
      )
    ) {
      return 'HANDED_OVER';
    }

    if (
      vendorOrder.status === VendorOrderStatus.IN_TRANSIT &&
      delivery?.pickedUpAt !== null &&
      delivery?.pickedUpAt !== undefined
    ) {
      return 'IN_TRANSIT';
    }

    return 'AWAITING_PICKUP';
  }

  private buildInactivePart(
    basePart: Omit<
      CustomerTrackedDeliveryPartEntity,
      | 'stage'
      | 'statusLabel'
      | 'onBoard'
      | 'isLocationShared'
      | 'locationStatus'
      | 'locationMessage'
      | 'location'
    >,
    stage: Exclude<CustomerDeliveryTrackingStage, 'IN_TRANSIT'>,
    vendorStatus: VendorOrderStatus,
  ): CustomerTrackedDeliveryPartEntity {
    if (stage === 'AWAITING_PICKUP') {
      return {
        ...basePart,
        stage,
        statusLabel: this.formatPrePickupStatusLabel(vendorStatus),
        onBoard: false,
        isLocationShared: false,
        locationStatus: 'NOT_STARTED',
        locationMessage:
          'Vehicle location will appear once this delivery is picked up and on board.',
        location: null,
      };
    }

    const meta = TERMINAL_STAGE_LABELS[stage];
    return {
      ...basePart,
      stage,
      statusLabel: meta.statusLabel,
      onBoard: false,
      isLocationShared: false,
      locationStatus: 'ENDED',
      locationMessage: meta.locationMessage,
      location: null,
    };
  }

  private resolveOnBoardVehicle(vendorOrder: VendorOrderTrackingRecord): TrackedVehicleGps | null {
    const openAssignments = vendorOrder.cargoAssignments.filter(
      (assignment) =>
        assignment.unloadedAt === null &&
        assignment.handedOverQuantity < assignment.quantityUnits,
    );

    if (openAssignments.length > 0) {
      const withCoordinates = openAssignments.find(
        (assignment) =>
          assignment.fleetAsset.lastLatitude !== null &&
          assignment.fleetAsset.lastLongitude !== null &&
          assignment.fleetAsset.lastGpsCapturedAt !== null,
      );
      const selectedAssignment = withCoordinates ?? openAssignments[0];
      return selectedAssignment ? selectedAssignment.fleetAsset : null;
    }

    const delivery = vendorOrder.delivery;
    if (!delivery) {
      return null;
    }

    return (
      delivery.runStop?.deliveryRun?.fleetAsset ??
      delivery.driver.operatedFleetAssets[0] ??
      null
    );
  }

  private evaluateVehicleLocation(
    vehicle: TrackedVehicleGps | null,
    now: Date,
  ): {
    locationStatus: CustomerTrackedLocationStatus;
    locationMessage: string;
    location: CustomerTrackedLocationEntity | null;
  } {
    if (
      !vehicle ||
      vehicle.lastLatitude === null ||
      vehicle.lastLongitude === null ||
      vehicle.lastGpsCapturedAt === null
    ) {
      return {
        locationStatus: 'UNAVAILABLE',
        locationMessage:
          'Picked up / In transit — live GPS position is currently unavailable.',
        location: null,
      };
    }

    const gpsStatus = computeVehicleGpsStatus(vehicle, now);
    const captureAgeMs = now.getTime() - vehicle.lastGpsCapturedAt.getTime();
    const isStale =
      gpsStatus === 'STALE' ||
      gpsStatus === 'OFFLINE' ||
      gpsStatus === 'NO_FIX' ||
      captureAgeMs > STALE_TELEMETRY_THRESHOLD_MS;

    const label = isStale ? 'Last reported location' : 'Live vehicle location';
    const locationStatus: CustomerTrackedLocationStatus = isStale ? 'STALE' : 'LIVE';
    const locationMessage = isStale
      ? 'Last reported location — GPS updates are currently delayed.'
      : 'Live vehicle location is active while your order is in transit.';

    return {
      locationStatus,
      locationMessage,
      location: {
        latitude: vehicle.lastLatitude,
        longitude: vehicle.lastLongitude,
        capturedAt: vehicle.lastGpsCapturedAt.toISOString(),
        stale: isStale,
        label,
      },
    };
  }

  private formatPrePickupStatusLabel(status: VendorOrderStatus): string {
    switch (status) {
      case VendorOrderStatus.PENDING:
        return 'Pending confirmation';
      case VendorOrderStatus.ACCEPTED:
        return 'Accepted by vendor';
      case VendorOrderStatus.PREPARING:
        return 'Preparing for pickup';
      case VendorOrderStatus.READY_FOR_PICKUP:
        return 'Ready for pickup';
      case VendorOrderStatus.ASSIGNED_TO_DRIVER:
        return 'Driver assigned (awaiting pickup)';
      default:
        return 'Awaiting pickup';
    }
  }
}
