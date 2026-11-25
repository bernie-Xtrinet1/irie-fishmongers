import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustodyEventType,
  DeliveryRunStatus,
  Prisma,
  RoleName,
  SeafoodStorageType,
  TemperatureDevice,
  TemperatureReadingOrigin,
  TelemetryProtocol,
  TrackerHardwareModel,
  TemperatureSensorModel,
  VendorOrderStatus,
} from '@prisma/client';

import { hasAdminPortalRole, isAdministratorRole } from '../../../common/auth/admin-roles';
import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import {
  computeSensorReportingStatus,
  computeVehicleGpsStatus,
  TelemetryReportingStatus,
  VehicleGpsStatus,
} from '../telemetry-status.util';
import {
  CreateVehicleCompartmentDto,
  ListTelemetryHistoryQueryDto,
  RecordCompartmentHandoverDto,
  RecordCompartmentPickupDto,
  RegisterCargoSensorDto,
  RegisterVehicleTrackerDto,
} from '../dto/telemetry.dto';

const ACTIVE_ORDER_DELIVERY_STATUSES: VendorOrderStatus[] = [
  VendorOrderStatus.READY_FOR_PICKUP,
  VendorOrderStatus.ASSIGNED_TO_DRIVER,
  VendorOrderStatus.IN_TRANSIT,
];

const ACTIVE_RUN_STATUSES: DeliveryRunStatus[] = [
  DeliveryRunStatus.PLANNED,
  DeliveryRunStatus.IN_PROGRESS,
];

function formatOrderAddress(order: {
  deliveryAddressLine1: string;
  deliveryAddressLine2?: string | null;
  deliveryParish: string;
} | null | undefined): string | null {
  if (!order) return null;
  return [order.deliveryAddressLine1, order.deliveryAddressLine2, order.deliveryParish]
    .filter(Boolean)
    .join(', ');
}

/**
 * Closes any still-open compartment assignments when a delivery terminates
 * (DELIVERED or DELIVERY_FAILED) so subsequent cargo-air telemetry never
 * attaches to already delivered or failed goods.
 */
export async function closeOpenCompartmentAssignmentsForDelivery(
  tx: Prisma.TransactionClient | PrismaService,
  deliveryId: string,
  closedAt: Date,
  options?: { markRemainingAsHandedOver?: boolean; actorUserId?: string; reason?: string },
): Promise<number> {
  if (!tx.cargoCompartmentAssignment || typeof tx.cargoCompartmentAssignment.findMany !== 'function') {
    return 0;
  }

  const openAssignments = await tx.cargoCompartmentAssignment.findMany({
    where: { deliveryId, unloadedAt: null },
  });
  if (openAssignments.length === 0) {
    return 0;
  }

  for (const assignment of openAssignments) {
    let handoverEventId = assignment.handoverCustodyEventId;
    if (options?.markRemainingAsHandedOver && !handoverEventId) {
      const custody = await tx.chainOfCustodyEvent.create({
        data: {
          lotId: assignment.lotId,
          deliveryId,
          compartmentId: assignment.compartmentId,
          fleetAssetId: assignment.fleetAssetId,
          eventType: CustodyEventType.DELIVERY,
          fromUserId: options.actorUserId ?? null,
          notes: options.reason ?? 'Delivery completed; closed cargo compartment attribution window',
          occurredAt: closedAt,
        },
        select: { id: true },
      });
      handoverEventId = custody.id;
    }

    await tx.cargoCompartmentAssignment.update({
      where: { id: assignment.id },
      data: {
        unloadedAt: closedAt,
        ...(options?.markRemainingAsHandedOver
          ? { handedOverQuantity: assignment.quantityUnits }
          : {}),
        ...(handoverEventId ? { handoverCustodyEventId: handoverEventId } : {}),
      },
    });
  }

  return openAssignments.length;
}

@Injectable()
export class TelemetryOperationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createCompartment(dto: CreateVehicleCompartmentDto) {
    const asset = await this.prisma.fleetAsset.findUnique({
      where: { id: dto.fleetAssetId },
      select: { id: true, coldChainCapable: true },
    });
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const code = dto.compartmentCode.trim().toUpperCase();
    const existing = await this.prisma.vehicleCompartment.findUnique({
      where: {
        fleetAssetId_compartmentCode: {
          fleetAssetId: dto.fleetAssetId,
          compartmentCode: code,
        },
      },
    });
    if (existing) {
      throw new ConflictException(`Compartment ${code} is already registered on this vehicle`);
    }

    const compartment = await this.prisma.vehicleCompartment.create({
      data: {
        fleetAssetId: dto.fleetAssetId,
        compartmentCode: code,
        label: dto.label.trim(),
        storageType: dto.storageType ?? SeafoodStorageType.FRESH,
        targetMinC: dto.targetMinC ?? null,
        targetMaxC: dto.targetMaxC ?? null,
        active: true,
      },
    });

    if (!asset.coldChainCapable) {
      await this.prisma.fleetAsset.update({
        where: { id: asset.id },
        data: { coldChainCapable: true },
      });
    }

    return compartment;
  }

  async registerTracker(dto: RegisterVehicleTrackerDto) {
    const asset = await this.prisma.fleetAsset.findUnique({
      where: { id: dto.fleetAssetId },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const existing = await this.prisma.vehicleTracker.findUnique({
      where: { imei: dto.imei },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`Tracker with IMEI ${dto.imei} is already registered`);
    }

    return this.prisma.vehicleTracker.create({
      data: {
        fleetAssetId: dto.fleetAssetId,
        imei: dto.imei,
        hardwareModel: dto.hardwareModel ?? TrackerHardwareModel.TELTONIKA_FMC130,
        firmwareVersion: dto.firmwareVersion?.trim() || null,
        simIccid: dto.simIccid?.trim() || null,
        simCarrier: dto.simCarrier?.trim() || null,
        protocol: dto.protocol ?? TelemetryProtocol.TELTONIKA_CODEC_8E,
      },
    });
  }

  async registerCargoSensor(dto: RegisterCargoSensorDto) {
    const compartment = await this.prisma.vehicleCompartment.findUnique({
      where: { id: dto.compartmentId },
      select: { id: true },
    });
    if (!compartment) {
      throw new NotFoundException('Vehicle compartment not found');
    }

    const code = dto.deviceCode.trim();
    const existingCode = await this.prisma.temperatureDevice.findUnique({
      where: { deviceCode: code },
      select: { id: true },
    });
    if (existingCode) {
      throw new ConflictException(`Sensor deviceCode ${code} is already registered`);
    }

    const normalizedMac = dto.bleMacAddress ? dto.bleMacAddress.trim().toUpperCase() : null;
    if (normalizedMac) {
      const existingMac = await this.prisma.temperatureDevice.findUnique({
        where: { bleMacAddress: normalizedMac },
        select: { id: true },
      });
      if (existingMac) {
        throw new ConflictException(`BLE MAC address ${normalizedMac} is already assigned`);
      }
    }

    if (dto.vendorId) {
      const vendor = await this.prisma.vendor.findUnique({
        where: { id: dto.vendorId },
        select: { id: true },
      });
      if (!vendor) {
        throw new NotFoundException('Vendor not found');
      }
    }

    const sensor = await this.prisma.temperatureDevice.create({
      data: {
        vendorId: dto.vendorId ?? null,
        compartmentId: compartment.id,
        deviceCode: code,
        hardwareModel: dto.hardwareModel ?? TemperatureSensorModel.TELTONIKA_EYE_BTSMP1_EN12830,
        bleMacAddress: normalizedMac,
        sensorSlot: dto.sensorSlot ?? 1,
        firmwareVersion: dto.firmwareVersion?.trim() || null,
      },
    });

    return {
      ...sensor,
      lastTemperatureC: null,
      lastHumidityPct: null,
      reportingStatus: computeSensorReportingStatus(sensor),
    };
  }

  private async assertCanOperateDelivery(user: RequestUser, deliveryId: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        driver: {
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
        vendorOrder: {
          include: {
            vendor: {
              select: { id: true, userId: true, businessName: true },
            },
            order: {
              select: {
                deliveryAddressLine1: true,
                deliveryAddressLine2: true,
                deliveryParish: true,
              },
            },
            items: {
              select: {
                id: true,
                quantity: true,
                productName: true,
                originalLotId: true,
                product: { select: { id: true, lotId: true } },
              },
            },
          },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    const isPortalOps = hasAdminPortalRole(user.roles);
    if (!isPortalOps) {
      const isDriverRole = user.roles.includes(RoleName.DRIVER);
      if (!isDriverRole || delivery.driver?.userId !== user.id) {
        throw new ForbiddenException(
          'Only authorized operations staff or the assigned driver may access or update this delivery',
        );
      }
    }

    return delivery;
  }

  async recordCompartmentPickup(user: RequestUser, dto: RecordCompartmentPickupDto) {
    const delivery = await this.assertCanOperateDelivery(user, dto.deliveryId);

    if (
      delivery.vendorOrder.status === VendorOrderStatus.DELIVERED ||
      delivery.vendorOrder.status === VendorOrderStatus.DELIVERY_FAILED ||
      delivery.vendorOrder.status === VendorOrderStatus.CANCELLED ||
      delivery.deliveredAt ||
      delivery.failedAt
    ) {
      throw new BadRequestException(`Cannot load cargo onto a ${delivery.vendorOrder.status} delivery`);
    }

    const compartment = await this.prisma.vehicleCompartment.findUnique({
      where: { id: dto.compartmentId },
      include: {
        sensors: {
          where: { status: 'ACTIVE' },
          orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, deviceCode: true },
        },
      },
    });
    if (!compartment || compartment.fleetAssetId !== dto.fleetAssetId) {
      throw new BadRequestException('Selected compartment does not belong to the specified fleet vehicle');
    }

    const activeTracker = dto.trackerId
      ? await this.prisma.vehicleTracker.findFirst({
          where: { id: dto.trackerId, fleetAssetId: dto.fleetAssetId, status: 'ACTIVE' },
          select: { id: true, imei: true },
        })
      : await this.prisma.vehicleTracker.findFirst({
          where: { fleetAssetId: dto.fleetAssetId, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, imei: true },
        });

    let resolvedSensorId = dto.sensorDeviceId ?? compartment.sensors[0]?.id ?? null;
    if (dto.sensorDeviceId) {
      const validSensor = compartment.sensors.find((s) => s.id === dto.sensorDeviceId);
      if (!validSensor) {
        throw new BadRequestException('Selected temperature sensor is not active on this compartment');
      }
      resolvedSensorId = validSensor.id;
    }

    // Build expected max quantity per lot from vendor order items (prefers immutable originalLotId snapshot).
    const orderedQtyByLot = new Map<string, number>();
    for (const item of delivery.vendorOrder.items) {
      const lotId = item.originalLotId ?? item.product.lotId;
      if (!lotId) continue;
      orderedQtyByLot.set(lotId, (orderedQtyByLot.get(lotId) ?? 0) + item.quantity);
    }

    const existingAssignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: { deliveryId: delivery.id },
      select: { lotId: true, quantityUnits: true },
    });
    const alreadyLoadedByLot = new Map<string, number>();
    for (const row of existingAssignments) {
      alreadyLoadedByLot.set(row.lotId, (alreadyLoadedByLot.get(row.lotId) ?? 0) + row.quantityUnits);
    }

    for (const lotEntry of dto.lots) {
      const ordered = orderedQtyByLot.get(lotEntry.lotId);
      if (ordered === undefined) {
        throw new BadRequestException(`Lot ${lotEntry.lotId} does not belong to delivery ${delivery.id}`);
      }
      const alreadyLoaded = alreadyLoadedByLot.get(lotEntry.lotId) ?? 0;
      if (alreadyLoaded + lotEntry.quantityUnits > ordered) {
        throw new BadRequestException(
          `Cannot load ${alreadyLoaded + lotEntry.quantityUnits} units of lot ${lotEntry.lotId}; delivery order contains ${ordered}`,
        );
      }
    }

    const loadedAt = dto.loadedAt ? new Date(dto.loadedAt) : new Date();
    const vendorUserId = delivery.vendorOrder.vendor.userId;
    const driverUserId = delivery.driver?.userId ?? user.id;

    const created = await this.prisma.$transaction(async (tx) => {
      const rows = [];
      for (const lotEntry of dto.lots) {
        const custody = await tx.chainOfCustodyEvent.create({
          data: {
            lotId: lotEntry.lotId,
            deliveryId: delivery.id,
            compartmentId: compartment.id,
            fleetAssetId: dto.fleetAssetId,
            eventType: CustodyEventType.PICKUP,
            fromUserId: vendorUserId,
            toUserId: driverUserId,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            notes:
              dto.notes ??
              `Loaded ${lotEntry.quantityUnits} unit(s) into compartment ${compartment.compartmentCode}`,
            occurredAt: loadedAt,
          },
          select: { id: true },
        });

        const assignment = await tx.cargoCompartmentAssignment.create({
          data: {
            deliveryId: delivery.id,
            vendorOrderId: delivery.vendorOrderId,
            lotId: lotEntry.lotId,
            fleetAssetId: dto.fleetAssetId,
            compartmentId: compartment.id,
            trackerId: activeTracker?.id ?? null,
            sensorDeviceId: resolvedSensorId,
            quantityUnits: lotEntry.quantityUnits,
            handedOverQuantity: 0,
            loadedAt,
            pickupCustodyEventId: custody.id,
            recordedById: user.id,
            notes: dto.notes ?? null,
          },
        });
        rows.push(assignment);
      }
      return rows;
    });

    return {
      deliveryId: delivery.id,
      fleetAssetId: dto.fleetAssetId,
      compartmentId: compartment.id,
      trackerId: activeTracker?.id ?? null,
      sensorDeviceId: resolvedSensorId,
      loadedAt,
      assignments: created,
    };
  }

  async recordCompartmentHandover(user: RequestUser, dto: RecordCompartmentHandoverDto) {
    const delivery = await this.assertCanOperateDelivery(user, dto.deliveryId);

    const openAssignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: {
        deliveryId: delivery.id,
        unloadedAt: null,
        ...(dto.compartmentId ? { compartmentId: dto.compartmentId } : {}),
      },
      orderBy: { loadedAt: 'asc' },
    });

    if (openAssignments.length === 0) {
      throw new BadRequestException('No open cargo compartment assignments found for this delivery');
    }

    const handoverQtyByLot = new Map<string, number>();
    if (dto.items && dto.items.length > 0) {
      for (const item of dto.items) {
        handoverQtyByLot.set(
          item.lotId,
          (handoverQtyByLot.get(item.lotId) ?? 0) + item.handedOverQuantity,
        );
      }
    } else {
      for (const a of openAssignments) {
        const remaining = a.quantityUnits - a.handedOverQuantity;
        handoverQtyByLot.set(a.lotId, (handoverQtyByLot.get(a.lotId) ?? 0) + remaining);
      }
    }

    const unloadedAt = dto.unloadedAt ? new Date(dto.unloadedAt) : new Date();
    const fromUserId = delivery.driver?.userId ?? user.id;

    // Group matching assignments chronologically so partial handovers decrement oldest lots cleanly.
    const updates: Array<{
      assignment: (typeof openAssignments)[number];
      handoverQty: number;
      nextHandedOver: number;
      closed: boolean;
    }> = [];

    for (const [lotId, requestedQty] of handoverQtyByLot.entries()) {
      const lotAssignments = openAssignments.filter((a) => a.lotId === lotId);
      const totalRemaining = lotAssignments.reduce(
        (sum, a) => sum + (a.quantityUnits - a.handedOverQuantity),
        0,
      );
      if (lotAssignments.length === 0 || requestedQty > totalRemaining) {
        throw new BadRequestException(
          `Cannot hand over ${requestedQty} unit(s) for lot ${lotId}; ${totalRemaining} remaining onboard`,
        );
      }

      let leftToAllocate = requestedQty;
      for (const assignment of lotAssignments) {
        if (leftToAllocate <= 0) break;
        const remainingHere = assignment.quantityUnits - assignment.handedOverQuantity;
        const delta = Math.min(remainingHere, leftToAllocate);
        leftToAllocate -= delta;
        const nextHandedOver = assignment.handedOverQuantity + delta;
        updates.push({
          assignment,
          handoverQty: delta,
          nextHandedOver,
          closed: nextHandedOver >= assignment.quantityUnits,
        });
      }
    }

    const results = await this.prisma.$transaction(async (tx) => {
      const updatedRows = [];
      for (const entry of updates) {
        const remainingAfter = entry.assignment.quantityUnits - entry.nextHandedOver;
        const custody = await tx.chainOfCustodyEvent.create({
          data: {
            lotId: entry.assignment.lotId,
            deliveryId: delivery.id,
            compartmentId: entry.assignment.compartmentId,
            fleetAssetId: entry.assignment.fleetAssetId,
            eventType: CustodyEventType.DELIVERY,
            fromUserId,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            notes:
              dto.notes ??
              (remainingAfter > 0
                ? `Partial compartment handover (${entry.handoverQty} handed over, ${remainingAfter} remaining onboard)`
                : `Completed compartment handover (${entry.handoverQty} units unloaded)`),
            occurredAt: unloadedAt,
          },
          select: { id: true },
        });

        const updated = await tx.cargoCompartmentAssignment.update({
          where: { id: entry.assignment.id },
          data: {
            handedOverQuantity: entry.nextHandedOver,
            handoverCustodyEventId: custody.id,
            ...(entry.closed ? { unloadedAt } : {}),
          },
        });
        updatedRows.push(updated);
      }
      return updatedRows;
    });

    return {
      deliveryId: delivery.id,
      unloadedAt,
      updatedAssignments: results,
    };
  }

  async getActiveRunsLiveOverview(user?: RequestUser, now = new Date()) {
    const isAdminOrOps = !user || isAdministratorRole(user.roles) || hasAdminPortalRole(user.roles);
    let scopedDriverId: string | undefined;

    if (!isAdminOrOps) {
      const driver = await this.prisma.driver.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!driver) {
        return { runs: [], activeDeliveries: [], vehicles: [], generatedAt: now };
      }
      scopedDriverId = driver.id;
    }

    const [runs, activeDeliveries] = await Promise.all([
      this.prisma.deliveryRun.findMany({
        where: {
          status: { in: ACTIVE_RUN_STATUSES },
          ...(scopedDriverId ? { driverId: scopedDriverId } : {}),
        },
        include: {
          zone: { select: { id: true, name: true } },
          driver: {
            select: {
              id: true,
              vehicleType: true,
              licensePlate: true,
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
          fleetAsset: {
            include: {
              trackers: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'asc' },
              },
              compartments: {
                where: { active: true },
                include: {
                  sensors: {
                    where: { status: 'ACTIVE' },
                  },
                },
              },
            },
          },
          stops: {
            orderBy: { sequence: 'asc' },
            include: {
              delivery: {
                select: {
                  id: true,
                  vendorOrderId: true,
                  vendorOrder: {
                    select: {
                      status: true,
                      order: {
                        select: {
                          deliveryAddressLine1: true,
                          deliveryAddressLine2: true,
                          deliveryParish: true,
                        },
                      },
                    },
                  },
                  cargoAssignments: {
                    select: {
                      id: true,
                      lotId: true,
                      quantityUnits: true,
                      handedOverQuantity: true,
                      unloadedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.delivery.findMany({
        where: {
          deliveredAt: null,
          failedAt: null,
          vendorOrder: {
            status: { in: ACTIVE_ORDER_DELIVERY_STATUSES },
          },
          ...(scopedDriverId ? { driverId: scopedDriverId } : {}),
        },
        include: {
          driver: {
            select: {
              id: true,
              licensePlate: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          vendorOrder: {
            select: {
              id: true,
              status: true,
              vendor: { select: { id: true, businessName: true } },
              order: {
                select: {
                  deliveryAddressLine1: true,
                  deliveryAddressLine2: true,
                  deliveryParish: true,
                },
              },
            },
          },
          cargoAssignments: {
            include: {
              fleetAsset: {
                include: {
                  trackers: { where: { status: 'ACTIVE' } },
                  compartments: {
                    where: { active: true },
                    include: { sensors: { where: { status: 'ACTIVE' } } },
                  },
                },
              },
            },
          },
          runStop: {
            select: { id: true, deliveryRunId: true, sequence: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const vehicleMap = new Map<
      string,
      {
        fleetAssetId: string;
        licensePlate: string;
        assetType: string;
        gpsStatus: VehicleGpsStatus;
        lastLatitude: number | null;
        lastLongitude: number | null;
        lastSpeedKph: number | null;
        lastHeadingDeg: number | null;
        lastSatellites: number | null;
        lastGpsCapturedAt: Date | null;
        lastTelemetryReceivedAt: Date | null;
        lastTelemetryDelayed: boolean;
        trackerImei: string | null;
        compartments: Array<{
          id: string;
          compartmentCode: string;
          label: string;
          storageType: string;
          sensors: Array<{
            id: string;
            deviceCode: string;
            lastTemperatureC: number | null;
            lastCapturedAt: Date | null;
            lastDelaySeconds: number | null;
            reportingStatus: TelemetryReportingStatus;
          }>;
        }>;
      }
    >();

    const registerVehicle = (
      asset: {
        id: string;
        licensePlate: string;
        assetType: string;
        lastLatitude: number | null;
        lastLongitude: number | null;
        lastSpeedKph: number | null;
        lastHeadingDeg: number | null;
        lastSatellites: number | null;
        lastGpsCapturedAt: Date | null;
        lastTelemetryReceivedAt: Date | null;
        lastTelemetryDelayed: boolean;
        lastGpsNoFixAt: Date | null;
        trackers: Array<{ imei: string }>;
        compartments: Array<{
          id: string;
          compartmentCode: string;
          label: string;
          storageType: string;
          sensors: TemperatureDevice[];
        }>;
      } | null | undefined,
    ) => {
      if (!asset || vehicleMap.has(asset.id)) return;
      vehicleMap.set(asset.id, {
        fleetAssetId: asset.id,
        licensePlate: asset.licensePlate,
        assetType: asset.assetType,
        gpsStatus: computeVehicleGpsStatus(asset, now),
        lastLatitude: asset.lastLatitude,
        lastLongitude: asset.lastLongitude,
        lastSpeedKph: asset.lastSpeedKph,
        lastHeadingDeg: asset.lastHeadingDeg,
        lastSatellites: asset.lastSatellites,
        lastGpsCapturedAt: asset.lastGpsCapturedAt,
        lastTelemetryReceivedAt: asset.lastTelemetryReceivedAt,
        lastTelemetryDelayed: asset.lastTelemetryDelayed,
        trackerImei: asset.trackers[0]?.imei ?? null,
        compartments: asset.compartments.map((comp) => ({
          id: comp.id,
          compartmentCode: comp.compartmentCode,
          label: comp.label,
          storageType: comp.storageType,
          sensors: comp.sensors.map((s) => ({
            id: s.id,
            deviceCode: s.deviceCode,
            lastTemperatureC: s.lastTemperatureC ? Number(s.lastTemperatureC.toString()) : null,
            lastCapturedAt: s.lastCapturedAt,
            lastDelaySeconds: s.lastDelaySeconds,
            reportingStatus: computeSensorReportingStatus(s, now),
          })),
        })),
      });
    };

    for (const run of runs) {
      registerVehicle(run.fleetAsset);
    }
    for (const delivery of activeDeliveries) {
      for (const assignment of delivery.cargoAssignments) {
        registerVehicle(assignment.fleetAsset);
      }
    }

    const deliveryRows = activeDeliveries.map((d) => {
      const firstAssignment = d.cargoAssignments[0];
      const vehicleSummary = firstAssignment ? vehicleMap.get(firstAssignment.fleetAssetId) ?? null : null;
      return {
        deliveryId: d.id,
        vendorOrderId: d.vendorOrderId,
        vendorName: d.vendorOrder.vendor.businessName,
        status: d.vendorOrder.status,
        deliveryAddress: formatOrderAddress(d.vendorOrder.order),
        runId: d.runStop?.deliveryRunId ?? null,
        stopSequence: d.runStop?.sequence ?? null,
        driverName: d.driver ? `${d.driver.user.firstName} ${d.driver.user.lastName}` : null,
        fleetAssetId: vehicleSummary?.fleetAssetId ?? null,
        licensePlate: vehicleSummary?.licensePlate ?? null,
        gpsStatus: vehicleSummary?.gpsStatus ?? 'OFFLINE',
        lastLatitude: vehicleSummary?.lastLatitude ?? null,
        lastLongitude: vehicleSummary?.lastLongitude ?? null,
        lastGpsCapturedAt: vehicleSummary?.lastGpsCapturedAt ?? null,
        lastTelemetryDelayed: vehicleSummary?.lastTelemetryDelayed ?? false,
        onboardLotCount: d.cargoAssignments.filter((a) => a.unloadedAt === null).length,
        latestCargoTempC:
          vehicleSummary?.compartments[0]?.sensors[0]?.lastTemperatureC ?? null,
        sensorReportingStatus:
          vehicleSummary?.compartments[0]?.sensors[0]?.reportingStatus ?? null,
      };
    });

    return {
      generatedAt: now,
      vehicles: Array.from(vehicleMap.values()),
      runs: runs.map((run) => ({
        id: run.id,
        zoneId: run.zoneId,
        zoneName: run.zone.name,
        status: run.status,
        driverName: run.driver ? `${run.driver.user.firstName} ${run.driver.user.lastName}` : null,
        fleetAssetId: run.fleetAssetId,
        vehicle: run.fleetAssetId ? vehicleMap.get(run.fleetAssetId) ?? null : null,
        stops: run.stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          deliveryId: stop.deliveryId,
          deliveryStatus: stop.delivery.vendorOrder.status,
          deliveryAddress: formatOrderAddress(stop.delivery.vendorOrder.order),
          openLotCount: stop.delivery.cargoAssignments.filter((a) => a.unloadedAt === null).length,
        })),
        createdAt: run.createdAt,
      })),
      activeDeliveries: deliveryRows,
    };
  }

  async getDeliveryTelemetryDetail(user: RequestUser, deliveryId: string, now = new Date()) {
    const delivery = await this.assertCanOperateDelivery(user, deliveryId);

    const assignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: { deliveryId },
      include: {
        lot: {
          select: {
            id: true,
            lotNumber: true,
            species: true,
            storageType: true,
            foodSafetyStatus: true,
          },
        },
        fleetAsset: {
          select: {
            id: true,
            licensePlate: true,
            assetType: true,
            lastLatitude: true,
            lastLongitude: true,
            lastSpeedKph: true,
            lastHeadingDeg: true,
            lastSatellites: true,
            lastGpsCapturedAt: true,
            lastTelemetryReceivedAt: true,
            lastTelemetryDelayed: true,
            lastGpsNoFixAt: true,
          },
        },
        compartment: {
          select: {
            id: true,
            compartmentCode: true,
            label: true,
            storageType: true,
            targetMinC: true,
            targetMaxC: true,
          },
        },
        tracker: {
          select: {
            id: true,
            imei: true,
            hardwareModel: true,
            simCarrier: true,
            lastSeenAt: true,
            lastCapturedAt: true,
          },
        },
        sensorDevice: true,
        pickupCustodyEvent: true,
        handoverCustodyEvent: true,
      },
      orderBy: { loadedAt: 'asc' },
    });

    const lotIds = Array.from(
      new Set([
        ...assignments.map((a) => a.lotId),
        ...delivery.vendorOrder.items
          .map((item) => item.originalLotId ?? item.product.lotId)
          .filter((id): id is string => Boolean(id)),
      ]),
    );

    const [allReadings, alerts] = await Promise.all([
      lotIds.length > 0
        ? this.prisma.temperatureReading.findMany({
            where: {
              OR: [{ deliveryId }, { lotId: { in: lotIds } }],
            },
            include: {
              lot: { select: { id: true, lotNumber: true, species: true } },
              device: { select: { id: true, deviceCode: true, hardwareModel: true } },
            },
            orderBy: { recordedAt: 'desc' },
            take: 150,
          })
        : Promise.resolve([]),
      lotIds.length > 0
        ? this.prisma.temperatureAlert.findMany({
            where: { lotId: { in: lotIds } },
            include: {
              emergencyResponse: true,
              reading: {
                select: {
                  id: true,
                  origin: true,
                  capturedAt: true,
                  receivedAt: true,
                  isDelayed: true,
                  deliveryId: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    const manualProductChecks = allReadings.filter(
      (r) => r.origin === TemperatureReadingOrigin.MANUAL_PRODUCT_CHECK,
    );
    const cargoAirReadings = allReadings.filter(
      (r) => r.origin !== TemperatureReadingOrigin.MANUAL_PRODUCT_CHECK,
    );

    const compartmentIds = Array.from(new Set(assignments.map((a) => a.compartmentId)));
    const earliestLoad =
      assignments.length > 0
        ? new Date(Math.min(...assignments.map((a) => a.loadedAt.getTime())))
        : delivery.createdAt;
    const latestBoundary = assignments.some((a) => a.unloadedAt === null)
      ? now
      : assignments.length > 0
        ? new Date(Math.max(...assignments.map((a) => (a.unloadedAt ?? now).getTime())))
        : now;

    const frames =
      compartmentIds.length > 0
        ? await this.prisma.vehicleTelemetryFrame.findMany({
            where: {
              compartmentId: { in: compartmentIds },
              capturedAt: { gte: earliestLoad, lte: latestBoundary },
            },
            orderBy: { capturedAt: 'desc' },
            take: 100,
          })
        : [];

    const telemetryGaps = frames
      .filter((f) => f.gapKind !== null)
      .map((f) => ({
        frameId: f.id,
        gapKind: f.gapKind!,
        capturedAt: f.capturedAt,
        receivedAt: f.receivedAt,
        delaySeconds: f.delaySeconds,
        latitude: f.latitude,
        longitude: f.longitude,
      }));

    const pickupCheckCount = manualProductChecks.filter(
      (r) => r.checkpoint === 'DRIVER_PICKUP' || r.checkpoint === 'VEHICLE_LOADING',
    ).length;
    const deliveryCheckCount = manualProductChecks.filter(
      (r) => r.checkpoint === 'DELIVERY' || r.checkpoint === 'CUSTOMER_ACCEPTANCE',
    ).length;

    const primaryFleetAsset = assignments[0]?.fleetAsset ?? null;

    return {
      delivery: {
        id: delivery.id,
        vendorOrderId: delivery.vendorOrderId,
        status: delivery.vendorOrder.status,
        deliveryAddress: formatOrderAddress(delivery.vendorOrder.order),
        assignedAt: delivery.assignedAt,
        pickedUpAt: delivery.pickedUpAt,
        deliveredAt: delivery.deliveredAt,
        vendorName: delivery.vendorOrder.vendor.businessName,
        driverName: delivery.driver
          ? `${delivery.driver.user.firstName} ${delivery.driver.user.lastName}`
          : null,
      },
      vehicle: primaryFleetAsset
        ? {
            id: primaryFleetAsset.id,
            licensePlate: primaryFleetAsset.licensePlate,
            assetType: primaryFleetAsset.assetType,
            gpsStatus: computeVehicleGpsStatus(primaryFleetAsset, now),
            lastLatitude: primaryFleetAsset.lastLatitude,
            lastLongitude: primaryFleetAsset.lastLongitude,
            lastSpeedKph: primaryFleetAsset.lastSpeedKph,
            lastHeadingDeg: primaryFleetAsset.lastHeadingDeg,
            lastSatellites: primaryFleetAsset.lastSatellites,
            lastGpsCapturedAt: primaryFleetAsset.lastGpsCapturedAt,
            lastTelemetryReceivedAt: primaryFleetAsset.lastTelemetryReceivedAt,
            lastTelemetryDelayed: primaryFleetAsset.lastTelemetryDelayed,
          }
        : null,
      assignments: assignments.map((a) => ({
        id: a.id,
        lotId: a.lot.id,
        lotNumber: a.lot.lotNumber,
        species: a.lot.species,
        storageType: a.lot.storageType,
        foodSafetyStatus: a.lot.foodSafetyStatus,
        compartmentId: a.compartment.id,
        compartmentCode: a.compartment.compartmentCode,
        compartmentLabel: a.compartment.label,
        trackerImei: a.tracker?.imei ?? null,
        sensorId: a.sensorDevice?.id ?? null,
        sensorDeviceCode: a.sensorDevice?.deviceCode ?? null,
        sensorReportingStatus: a.sensorDevice
          ? computeSensorReportingStatus(a.sensorDevice, now)
          : null,
        sensorLastTempC: a.sensorDevice?.lastTemperatureC
          ? Number(a.sensorDevice.lastTemperatureC.toString())
          : null,
        quantityUnits: a.quantityUnits,
        handedOverQuantity: a.handedOverQuantity,
        loadedAt: a.loadedAt,
        unloadedAt: a.unloadedAt,
        pickupCustodyEventId: a.pickupCustodyEventId,
        handoverCustodyEventId: a.handoverCustodyEventId,
      })),
      manualProductChecks: manualProductChecks.map((r) => ({
        id: r.id,
        lotId: r.lotId,
        lotNumber: r.lot.lotNumber,
        checkpoint: r.checkpoint,
        temperatureC: r.temperatureC.toString(),
        origin: r.origin,
        capturedAt: r.capturedAt ?? r.recordedAt,
        receivedAt: r.receivedAt,
        recordedAt: r.recordedAt,
        photoUrl: r.photoUrl,
      })),
      cargoAirReadings: cargoAirReadings.map((r) => ({
        id: r.id,
        lotId: r.lotId,
        lotNumber: r.lot.lotNumber,
        deviceId: r.deviceId,
        deviceCode: r.device?.deviceCode ?? null,
        checkpoint: r.checkpoint,
        temperatureC: r.temperatureC.toString(),
        origin: r.origin,
        capturedAt: r.capturedAt ?? r.recordedAt,
        receivedAt: r.receivedAt,
        isDelayed: r.isDelayed,
        latitude: r.latitude,
        longitude: r.longitude,
      })),
      complianceChecklist: {
        pickupManualCheckRecorded: pickupCheckCount > 0,
        deliveryManualCheckRecorded: deliveryCheckCount > 0,
        continuousSensorActive: assignments.some((a) => Boolean(a.sensorDeviceId)),
        manualChecksDistinctNotice:
          'Continuous cargo-air sensor readings never automatically satisfy required manual pickup or delivery product-temperature checks.',
      },
      alerts: alerts.map((a) => ({
        id: a.id,
        lotId: a.lotId,
        severity: a.severity,
        actualC: a.actualC.toString(),
        resolved: a.resolved,
        createdAt: a.createdAt,
        readingOrigin: a.reading.origin,
        readingCapturedAt: a.reading.capturedAt,
        isDelayed: a.reading.isDelayed,
        emergencyResponse: a.emergencyResponse
          ? {
              id: a.emergencyResponse.id,
              status: a.emergencyResponse.status,
              acknowledgedAt: a.emergencyResponse.acknowledgedAt,
              resolvedAt: a.emergencyResponse.resolvedAt,
            }
          : null,
      })),
      telemetryGaps,
      gpsTrail: frames
        .filter((f) => f.gnssValid && f.latitude !== null && f.longitude !== null)
        .map((f) => ({
          latitude: f.latitude!,
          longitude: f.longitude!,
          speedKph: f.speedKph,
          capturedAt: f.capturedAt,
          isDelayed: f.isDelayed,
        })),
    };
  }

  async getTelemetryDevicesOverview(now = new Date()) {
    const [trackers, sensors] = await Promise.all([
      this.prisma.vehicleTracker.findMany({
        include: {
          fleetAsset: {
            select: {
              id: true,
              licensePlate: true,
              assetType: true,
              status: true,
              lastLatitude: true,
              lastLongitude: true,
              lastGpsCapturedAt: true,
              lastTelemetryReceivedAt: true,
              lastTelemetryDelayed: true,
              lastGpsNoFixAt: true,
            },
          },
          credentials: {
            where: { active: true, revokedAt: null },
            select: { id: true, keyPrefix: true, expiresAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.temperatureDevice.findMany({
        include: {
          compartment: {
            include: {
              fleetAsset: {
                select: { id: true, licensePlate: true, assetType: true },
              },
            },
          },
          vendor: {
            select: { id: true, businessName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      generatedAt: now,
      trackers: trackers.map((t) => ({
        id: t.id,
        imei: t.imei,
        hardwareModel: t.hardwareModel,
        firmwareVersion: t.firmwareVersion,
        simCarrier: t.simCarrier,
        protocol: t.protocol,
        status: t.status,
        fleetAssetId: t.fleetAssetId,
        licensePlate: t.fleetAsset.licensePlate,
        gpsStatus: computeVehicleGpsStatus(t.fleetAsset, now),
        lastCapturedAt: t.lastCapturedAt,
        lastReceivedAt: t.lastReceivedAt,
        activeCredentialCount: t.credentials.length,
      })),
      sensors: sensors.map((s) => ({
        id: s.id,
        deviceCode: s.deviceCode,
        hardwareModel: s.hardwareModel,
        bleMacAddress: s.bleMacAddress,
        sensorSlot: s.sensorSlot,
        firmwareVersion: s.firmwareVersion,
        status: s.status,
        vendorId: s.vendorId,
        vendorName: s.vendor?.businessName ?? null,
        compartmentId: s.compartmentId,
        compartmentCode: s.compartment?.compartmentCode ?? null,
        compartmentLabel: s.compartment?.label ?? null,
        storageType: s.compartment?.storageType ?? null,
        fleetAssetId: s.compartment?.fleetAsset.id ?? null,
        licensePlate: s.compartment?.fleetAsset.licensePlate ?? null,
        lastTemperatureC: s.lastTemperatureC ? Number(s.lastTemperatureC.toString()) : null,
        lastCapturedAt: s.lastCapturedAt,
        lastReceivedAt: s.lastReceivedAt,
        lastDelaySeconds: s.lastDelaySeconds,
        lastHumidityPct: s.lastHumidityPct ? Number(s.lastHumidityPct.toString()) : null,
        lastBatteryMv: s.lastBatteryMv,
        lastDoorOpen: s.lastDoorOpen,
        lastMovement: s.lastMovement,
        lastGapKind: s.lastGapKind,
        lastSignalMissingAt: s.lastSignalMissingAt,
        reportingStatus: computeSensorReportingStatus(s, now),
      })),
    };
  }

  async getSensorTelemetryHistory(sensorId: string, query: ListTelemetryHistoryQueryDto, now = new Date()) {
    const sensor = await this.prisma.temperatureDevice.findUnique({
      where: { id: sensorId },
      include: {
        compartment: {
          include: {
            fleetAsset: { select: { id: true, licensePlate: true } },
          },
        },
      },
    });
    if (!sensor) {
      throw new NotFoundException('Temperature sensor device not found');
    }

    const hours = query.hours ?? 24;
    const limit = query.limit ?? 100;
    const since = new Date(now.getTime() - hours * 3600_000);

    const frames = await this.prisma.vehicleTelemetryFrame.findMany({
      where: {
        sensorDeviceId: sensor.id,
        capturedAt: { gte: since },
      },
      orderBy: { capturedAt: 'desc' },
      take: limit,
      include: {
        temperatureReadings: {
          select: {
            id: true,
            lotId: true,
            deliveryId: true,
            origin: true,
            alert: { select: { id: true, severity: true, resolved: true } },
          },
        },
      },
    });

    return {
      sensor: {
        id: sensor.id,
        deviceCode: sensor.deviceCode,
        hardwareModel: sensor.hardwareModel,
        bleMacAddress: sensor.bleMacAddress,
        sensorSlot: sensor.sensorSlot,
        fleetAssetId: sensor.compartment?.fleetAsset.id ?? null,
        licensePlate: sensor.compartment?.fleetAsset.licensePlate ?? null,
        compartmentCode: sensor.compartment?.compartmentCode ?? null,
        compartmentLabel: sensor.compartment?.label ?? null,
        lastTemperatureC: sensor.lastTemperatureC ? Number(sensor.lastTemperatureC.toString()) : null,
        lastCapturedAt: sensor.lastCapturedAt,
        lastReceivedAt: sensor.lastReceivedAt,
        lastDelaySeconds: sensor.lastDelaySeconds,
        reportingStatus: computeSensorReportingStatus(sensor, now),
      },
      frames: frames.map((f) => ({
        id: f.id,
        protocol: f.protocol,
        origin: f.origin,
        capturedAt: f.capturedAt,
        receivedAt: f.receivedAt,
        delaySeconds: f.delaySeconds,
        isDelayed: f.isDelayed,
        cargoTempC: f.cargoTempC ? Number(f.cargoTempC.toString()) : null,
        humidityPct: f.humidityPct ? Number(f.humidityPct.toString()) : null,
        doorOpen: f.doorOpen,
        movement: f.movement,
        batteryMv: f.batteryMv,
        latitude: f.latitude,
        longitude: f.longitude,
        gnssValid: f.gnssValid,
        gapKind: f.gapKind,
        linkedLotsCount: f.temperatureReadings.length,
        alertsCount: f.temperatureReadings.filter((r) => Boolean(r.alert)).length,
      })),
    };
  }
}
