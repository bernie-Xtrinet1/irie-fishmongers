import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompartmentKind,
  CustodyEventType,
  DeliveryRunStatus,
  FleetAssetType,
  Prisma,
  RoleName,
  SeafoodStorageType,
  TemperatureDevice,
  TemperatureReadingOrigin,
  TelemetryGapKind,
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
  AssignCoolerVehicleDto,
  CreateVehicleCompartmentDto,
  ListTelemetryHistoryQueryDto,
  RecordCompartmentHandoverDto,
  RecordCompartmentPickupDto,
  RecordCompartmentTransferDto,
  RegisterCargoSensorDto,
  RegisterVehicleTrackerDto,
  UnassignCoolerVehicleDto,
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

  private async assertVehicleAcceptsCooler(
    fleetAssetId: string,
    compartmentKind: CompartmentKind,
    excludeCompartmentId?: string,
  ): Promise<{ id: string; assetType: FleetAssetType; coldChainCapable: boolean; licensePlate: string }> {
    const asset = await this.prisma.fleetAsset.findUnique({
      where: { id: fleetAssetId },
      select: { id: true, assetType: true, coldChainCapable: true, licensePlate: true, status: true },
    });
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }
    if (asset.status === 'RETIRED') {
      throw new BadRequestException('Cannot assign cold-chain equipment to a retired fleet asset');
    }

    if (
      compartmentKind === CompartmentKind.PORTABLE_COOLER &&
      asset.assetType === FleetAssetType.MOTORBIKE
    ) {
      const existingCoolers = await this.prisma.vehicleCompartment.count({
        where: {
          fleetAssetId,
          compartmentKind: CompartmentKind.PORTABLE_COOLER,
          active: true,
          ...(excludeCompartmentId ? { id: { not: excludeCompartmentId } } : {}),
        },
      });
      if (existingCoolers >= 1) {
        throw new ConflictException(
          `Motorbike ${asset.licensePlate} already has 1 active portable cooler assigned; motorbikes support one cooler at a time`,
        );
      }
    }

    return asset;
  }

  private async resolveVehicleSensorSlot(
    fleetAssetId: string,
    requestedSlot?: number | null,
    preferredSlot?: number | null,
    excludeCompartmentId?: string,
  ): Promise<number> {
    const activeSensors = await this.prisma.temperatureDevice.findMany({
      where: {
        status: 'ACTIVE',
        compartment: {
          fleetAssetId,
          active: true,
          ...(excludeCompartmentId ? { id: { not: excludeCompartmentId } } : {}),
        },
      },
      select: { sensorSlot: true },
    });
    const usedSlots = new Set<number>(
      activeSensors.map((s) => s.sensorSlot).filter((slot): slot is number => typeof slot === 'number'),
    );

    if (requestedSlot !== undefined && requestedSlot !== null) {
      if (usedSlots.has(requestedSlot)) {
        throw new ConflictException(
          `BLE sensor slot #${requestedSlot} is already occupied by another cooler or compartment on this vehicle`,
        );
      }
      return requestedSlot;
    }

    if (preferredSlot && !usedSlots.has(preferredSlot)) {
      return preferredSlot;
    }

    for (const candidate of [1, 2, 3, 4]) {
      if (!usedSlots.has(candidate)) {
        return candidate;
      }
    }

    throw new ConflictException('All 4 Teltonika EYE BLE sensor slots on this vehicle are already occupied');
  }

  async createCompartment(dto: CreateVehicleCompartmentDto, actorUserId?: string) {
    const kind =
      dto.compartmentKind ??
      (dto.coolerCode ? CompartmentKind.PORTABLE_COOLER : CompartmentKind.FIXED_COMPARTMENT);
    const normalizedCoolerCode = dto.coolerCode
      ? dto.coolerCode.trim().toUpperCase()
      : kind === CompartmentKind.PORTABLE_COOLER && dto.compartmentCode
        ? dto.compartmentCode.trim().toUpperCase()
        : null;
    const code = (dto.compartmentCode?.trim() || normalizedCoolerCode || '').toUpperCase();

    if (!code) {
      throw new BadRequestException('compartmentCode or coolerCode is required');
    }
    if (kind === CompartmentKind.FIXED_COMPARTMENT && !dto.fleetAssetId) {
      throw new BadRequestException('fleetAssetId is required for a fixed vehicle compartment');
    }
    if (kind === CompartmentKind.PORTABLE_COOLER && !normalizedCoolerCode) {
      throw new BadRequestException('coolerCode is required for a portable cooler');
    }

    if (normalizedCoolerCode) {
      const existingCooler = await this.prisma.vehicleCompartment.findUnique({
        where: { coolerCode: normalizedCoolerCode },
        select: { id: true },
      });
      if (existingCooler) {
        throw new ConflictException(`Portable cooler ${normalizedCoolerCode} is already registered`);
      }
    }

    let asset: { id: string; assetType: FleetAssetType; coldChainCapable: boolean } | null = null;
    let allocatedSlot: number | null = dto.sensorSlot ?? null;

    if (dto.fleetAssetId) {
      asset = await this.assertVehicleAcceptsCooler(dto.fleetAssetId, kind);

      const existing = await this.prisma.vehicleCompartment.findFirst({
        where: {
          fleetAssetId: dto.fleetAssetId,
          compartmentCode: code,
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(`Compartment ${code} is already registered on this vehicle`);
      }

      if (dto.sensorSlot !== undefined && dto.sensorSlot !== null) {
        allocatedSlot = await this.resolveVehicleSensorSlot(dto.fleetAssetId, dto.sensorSlot, null);
      }
    }

    const compartment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.vehicleCompartment.create({
        data: {
          fleetAssetId: dto.fleetAssetId ?? null,
          compartmentKind: kind,
          coolerCode: normalizedCoolerCode,
          compartmentCode: code,
          label: dto.label.trim(),
          storageType: dto.storageType ?? SeafoodStorageType.FRESH,
          targetMinC: dto.targetMinC ?? null,
          targetMaxC: dto.targetMaxC ?? null,
          notes: dto.notes?.trim() || null,
          active: true,
        },
      });

      if (dto.fleetAssetId) {
        await tx.coolerVehicleAssignment.create({
          data: {
            compartmentId: created.id,
            fleetAssetId: dto.fleetAssetId,
            sensorSlot: allocatedSlot,
            assignedAt: new Date(),
            assignedById: actorUserId ?? null,
            notes: dto.notes?.trim() || 'Initial registration assignment',
          },
        });

        if (asset && !asset.coldChainCapable) {
          await tx.fleetAsset.update({
            where: { id: asset.id },
            data: { coldChainCapable: true },
          });
        }
      }

      return created;
    });

    return compartment;
  }

  async assignCoolerToVehicle(compartmentId: string, dto: AssignCoolerVehicleDto, user?: RequestUser) {
    const compartment = await this.prisma.vehicleCompartment.findUnique({
      where: { id: compartmentId },
      include: {
        sensors: {
          where: { status: 'ACTIVE' },
          orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!compartment) {
      throw new NotFoundException('Compartment or portable cooler not found');
    }
    if (!compartment.active) {
      throw new BadRequestException('Inactive compartments cannot be assigned to vehicles');
    }
    if (compartment.compartmentKind !== CompartmentKind.PORTABLE_COOLER) {
      throw new BadRequestException('Only portable coolers can be reassigned across fleet vehicles');
    }

    const codeCollision = await this.prisma.vehicleCompartment.findFirst({
      where: {
        fleetAssetId: dto.fleetAssetId,
        compartmentCode: compartment.compartmentCode,
        id: { not: compartment.id },
      },
      select: { id: true },
    });
    if (codeCollision) {
      throw new ConflictException(
        `Compartment code ${compartment.compartmentCode} is already in use on the target vehicle`,
      );
    }

    const targetAsset = await this.assertVehicleAcceptsCooler(
      dto.fleetAssetId,
      CompartmentKind.PORTABLE_COOLER,
      compartment.id,
    );

    const primarySensor = compartment.sensors[0] ?? null;
    const assignedSlot =
      primarySensor || dto.sensorSlot !== undefined
        ? await this.resolveVehicleSensorSlot(
            dto.fleetAssetId,
            dto.sensorSlot,
            primarySensor?.sensorSlot ?? 1,
            compartment.id,
          )
        : null;

    const assignedAt = dto.assignedAt ? new Date(dto.assignedAt) : new Date();
    const openCargoAssignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: { compartmentId: compartment.id, unloadedAt: null },
      orderBy: { loadedAt: 'asc' },
    });

    const destinationTracker =
      openCargoAssignments.length > 0
        ? await this.prisma.vehicleTracker.findFirst({
            where: { fleetAssetId: dto.fleetAssetId, status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.coolerVehicleAssignment.updateMany({
        where: { compartmentId: compartment.id, unassignedAt: null },
        data: {
          unassignedAt: assignedAt,
          unassignedById: user?.id ?? null,
        },
      });

      const historyEntry = await tx.coolerVehicleAssignment.create({
        data: {
          compartmentId: compartment.id,
          fleetAssetId: dto.fleetAssetId,
          sensorSlot: assignedSlot,
          assignedAt,
          assignedById: user?.id ?? null,
          notes:
            dto.notes?.trim() ||
            (compartment.fleetAssetId
              ? `Reassigned cooler ${compartment.coolerCode ?? compartment.compartmentCode} to ${targetAsset.licensePlate}`
              : `Assigned cooler ${compartment.coolerCode ?? compartment.compartmentCode} to ${targetAsset.licensePlate}`),
        },
      });

      const updatedCompartment = await tx.vehicleCompartment.update({
        where: { id: compartment.id },
        data: { fleetAssetId: dto.fleetAssetId },
      });

      if (primarySensor && assignedSlot !== null && primarySensor.sensorSlot !== assignedSlot) {
        await tx.temperatureDevice.update({
          where: { id: primarySensor.id },
          data: { sensorSlot: assignedSlot },
        });
      }

      if (!targetAsset.coldChainCapable) {
        await tx.fleetAsset.update({
          where: { id: targetAsset.id },
          data: { coldChainCapable: true },
        });
      }

      // Preserve time-windowed cargo attribution if a loaded cooler physically
      // moves between vehicles in transit.
      for (const cargo of openCargoAssignments) {
        if (cargo.fleetAssetId === dto.fleetAssetId) continue;
        const custody = await tx.chainOfCustodyEvent.create({
          data: {
            lotId: cargo.lotId,
            deliveryId: cargo.deliveryId,
            compartmentId: compartment.id,
            fleetAssetId: dto.fleetAssetId,
            eventType: CustodyEventType.TRANSIT,
            fromUserId: user?.id ?? null,
            notes:
              dto.notes?.trim() ||
              `Cooler ${compartment.coolerCode ?? compartment.compartmentCode} reassigned to ${targetAsset.licensePlate}`,
            occurredAt: assignedAt,
          },
          select: { id: true },
        });

        await tx.cargoCompartmentAssignment.update({
          where: { id: cargo.id },
          data: { unloadedAt: assignedAt, handoverCustodyEventId: custody.id },
        });

        await tx.cargoCompartmentAssignment.create({
          data: {
            deliveryId: cargo.deliveryId,
            vendorOrderId: cargo.vendorOrderId,
            lotId: cargo.lotId,
            fleetAssetId: dto.fleetAssetId,
            compartmentId: compartment.id,
            trackerId: destinationTracker?.id ?? null,
            sensorDeviceId: cargo.sensorDeviceId,
            quantityUnits: cargo.quantityUnits - cargo.handedOverQuantity,
            handedOverQuantity: 0,
            loadedAt: assignedAt,
            pickupCustodyEventId: custody.id,
            recordedById: user?.id ?? null,
            notes: `Transferred onboard cooler ${compartment.coolerCode ?? compartment.compartmentCode}`,
          },
        });
      }

      return { compartment: updatedCompartment, assignment: historyEntry };
    });

    return updated;
  }

  async unassignCoolerFromVehicle(
    compartmentId: string,
    dto: UnassignCoolerVehicleDto,
    user?: RequestUser,
  ) {
    const compartment = await this.prisma.vehicleCompartment.findUnique({
      where: { id: compartmentId },
      select: { id: true, compartmentKind: true, fleetAssetId: true, coolerCode: true, compartmentCode: true },
    });
    if (!compartment) {
      throw new NotFoundException('Compartment or portable cooler not found');
    }
    if (compartment.compartmentKind !== CompartmentKind.PORTABLE_COOLER) {
      throw new BadRequestException('Fixed compartments cannot be detached from their host vehicle');
    }
    if (!compartment.fleetAssetId) {
      throw new BadRequestException('This portable cooler is not currently assigned to any vehicle');
    }

    const openCargoCount = await this.prisma.cargoCompartmentAssignment.count({
      where: { compartmentId: compartment.id, unloadedAt: null },
    });
    if (openCargoCount > 0) {
      throw new ConflictException(
        'This cooler currently holds open seafood lots; hand over or transfer open lots before detaching it',
      );
    }

    const unassignedAt = dto.unassignedAt ? new Date(dto.unassignedAt) : new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.coolerVehicleAssignment.updateMany({
        where: { compartmentId: compartment.id, unassignedAt: null },
        data: {
          unassignedAt,
          unassignedById: user?.id ?? null,
          ...(dto.notes?.trim() ? { notes: dto.notes.trim() } : {}),
        },
      });

      return tx.vehicleCompartment.update({
        where: { id: compartment.id },
        data: { fleetAssetId: null },
      });
    });
  }

  async listCompartments(now = new Date()) {
    const compartments = await this.prisma.vehicleCompartment.findMany({
      include: {
        fleetAsset: {
          select: { id: true, licensePlate: true, assetType: true },
        },
        sensors: {
          orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
        },
        vehicleAssignments: {
          include: {
            fleetAsset: {
              select: { id: true, licensePlate: true, assetType: true },
            },
          },
          orderBy: { assignedAt: 'desc' },
        },
      },
      orderBy: [{ compartmentKind: 'desc' }, { createdAt: 'desc' }],
    });

    return compartments.map((c) => ({
      id: c.id,
      compartmentCode: c.compartmentCode,
      coolerCode: c.coolerCode,
      compartmentKind: c.compartmentKind,
      label: c.label,
      storageType: c.storageType,
      targetMinC: c.targetMinC ? Number(c.targetMinC.toString()) : null,
      targetMaxC: c.targetMaxC ? Number(c.targetMaxC.toString()) : null,
      active: c.active,
      fleetAssetId: c.fleetAssetId,
      licensePlate: c.fleetAsset?.licensePlate ?? null,
      assetType: c.fleetAsset?.assetType ?? null,
      sensors: c.sensors.map((s) => ({
        id: s.id,
        deviceCode: s.deviceCode,
        hardwareModel: s.hardwareModel,
        bleMacAddress: s.bleMacAddress,
        sensorSlot: s.sensorSlot,
        status: s.status,
        lastTemperatureC: s.lastTemperatureC ? Number(s.lastTemperatureC.toString()) : null,
        lastCapturedAt: s.lastCapturedAt,
        reportingStatus: computeSensorReportingStatus(s, now),
      })),
      assignmentHistory: c.vehicleAssignments.map((h) => ({
        id: h.id,
        compartmentId: h.compartmentId,
        fleetAssetId: h.fleetAssetId,
        licensePlate: h.fleetAsset.licensePlate,
        assetType: h.fleetAsset.assetType,
        sensorSlot: h.sensorSlot,
        assignedAt: h.assignedAt,
        unassignedAt: h.unassignedAt,
        notes: h.notes,
      })),
    }));
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
      select: { id: true, fleetAssetId: true },
    });
    if (!compartment) {
      throw new NotFoundException('Vehicle compartment not found');
    }

    const requestedSlot = dto.sensorSlot ?? 1;
    if (compartment.fleetAssetId) {
      await this.resolveVehicleSensorSlot(
        compartment.fleetAssetId,
        requestedSlot,
        requestedSlot,
        compartment.id,
      );
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
        sensorSlot: requestedSlot,
        firmwareVersion: dto.firmwareVersion?.trim() || null,
      },
    });

    if (compartment.fleetAssetId) {
      const coolerAssignmentDelegate = (
        this.prisma as unknown as {
          coolerVehicleAssignment?: { updateMany: (args: unknown) => Promise<unknown> };
        }
      ).coolerVehicleAssignment;
      if (coolerAssignmentDelegate && typeof coolerAssignmentDelegate.updateMany === 'function') {
        await coolerAssignmentDelegate.updateMany({
          where: {
            compartmentId: compartment.id,
            fleetAssetId: compartment.fleetAssetId,
            unassignedAt: null,
            sensorSlot: null,
          },
          data: { sensorSlot: requestedSlot },
        });
      }
    }

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
                deliveryZoneId: true,
              },
            },
            items: {
              select: {
                id: true,
                quantity: true,
                productName: true,
                originalLotId: true,
                originalLot: {
                  select: { id: true, lotNumber: true, species: true, storageType: true },
                },
                product: {
                  select: {
                    id: true,
                    lotId: true,
                    lot: { select: { id: true, lotNumber: true, species: true, storageType: true } },
                  },
                },
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

  async recordCompartmentTransfer(user: RequestUser, dto: RecordCompartmentTransferDto) {
    const delivery = await this.assertCanOperateDelivery(user, dto.deliveryId);

    const openAssignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: {
        deliveryId: delivery.id,
        unloadedAt: null,
        ...(dto.fromCompartmentId ? { compartmentId: dto.fromCompartmentId } : {}),
      },
      orderBy: { loadedAt: 'asc' },
    });

    if (openAssignments.length === 0) {
      throw new BadRequestException('No open cargo compartment assignments available to transfer');
    }

    const toCompartment = await this.prisma.vehicleCompartment.findUnique({
      where: { id: dto.toCompartmentId },
      include: {
        sensors: {
          where: { status: 'ACTIVE' },
          orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, sensorSlot: true },
        },
      },
    });
    const isMovingSamePortableCooler =
      toCompartment?.compartmentKind === CompartmentKind.PORTABLE_COOLER &&
      openAssignments.some(
        (a) => a.compartmentId === toCompartment.id && a.fleetAssetId !== dto.toFleetAssetId,
      );

    if (!toCompartment || !toCompartment.active) {
      throw new BadRequestException('Destination compartment is inactive or not found');
    }
    if (!isMovingSamePortableCooler && toCompartment.fleetAssetId !== dto.toFleetAssetId) {
      throw new BadRequestException('Destination compartment is inactive or does not belong to destination vehicle');
    }

    if (
      openAssignments.some(
        (a) => a.compartmentId === toCompartment.id && a.fleetAssetId === dto.toFleetAssetId,
      )
    ) {
      throw new BadRequestException('Cannot transfer cargo to the same compartment on the same vehicle');
    }

    if (isMovingSamePortableCooler) {
      await this.assertVehicleAcceptsCooler(
        dto.toFleetAssetId,
        CompartmentKind.PORTABLE_COOLER,
        toCompartment.id,
      );
    }

    const toTracker = dto.toTrackerId
      ? await this.prisma.vehicleTracker.findFirst({
          where: { id: dto.toTrackerId, fleetAssetId: dto.toFleetAssetId, status: 'ACTIVE' },
          select: { id: true },
        })
      : await this.prisma.vehicleTracker.findFirst({
          where: { fleetAssetId: dto.toFleetAssetId, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });

    let resolvedToSensorId = dto.toSensorDeviceId ?? toCompartment.sensors[0]?.id ?? null;
    if (dto.toSensorDeviceId) {
      const validSensor = toCompartment.sensors.find((s) => s.id === dto.toSensorDeviceId);
      if (!validSensor) {
        throw new BadRequestException('Selected destination temperature sensor is not active on destination compartment');
      }
      resolvedToSensorId = validSensor.id;
    }

    const transferQtyByLot = new Map<string, number>();
    if (dto.items && dto.items.length > 0) {
      for (const item of dto.items) {
        transferQtyByLot.set(
          item.lotId,
          (transferQtyByLot.get(item.lotId) ?? 0) + item.transferQuantity,
        );
      }
    } else {
      for (const a of openAssignments) {
        const remaining = a.quantityUnits - a.handedOverQuantity;
        if (remaining > 0) {
          transferQtyByLot.set(a.lotId, (transferQtyByLot.get(a.lotId) ?? 0) + remaining);
        }
      }
    }

    const transferPlan: Array<{
      assignment: (typeof openAssignments)[number];
      transferQty: number;
      fullRemainingTransfer: boolean;
    }> = [];

    for (const [lotId, requestedQty] of transferQtyByLot.entries()) {
      const lotAssignments = openAssignments.filter((a) => a.lotId === lotId);
      const totalRemaining = lotAssignments.reduce(
        (sum, a) => sum + (a.quantityUnits - a.handedOverQuantity),
        0,
      );
      if (lotAssignments.length === 0 || requestedQty <= 0 || requestedQty > totalRemaining) {
        throw new BadRequestException(
          `Cannot transfer ${requestedQty} unit(s) for lot ${lotId}; ${totalRemaining} available to transfer`,
        );
      }

      let leftToAllocate = requestedQty;
      for (const assignment of lotAssignments) {
        if (leftToAllocate <= 0) break;
        const remainingHere = assignment.quantityUnits - assignment.handedOverQuantity;
        if (remainingHere <= 0) continue;
        const delta = Math.min(remainingHere, leftToAllocate);
        leftToAllocate -= delta;
        transferPlan.push({
          assignment,
          transferQty: delta,
          fullRemainingTransfer: delta >= remainingHere,
        });
      }
    }

    const transferredAt = dto.transferredAt ? new Date(dto.transferredAt) : new Date();
    const actorUserId = delivery.driver?.userId ?? user.id;

    const assignedDestSlot = isMovingSamePortableCooler
      ? await this.resolveVehicleSensorSlot(
          dto.toFleetAssetId,
          null,
          toCompartment.sensors[0]?.sensorSlot ?? 1,
          toCompartment.id,
        )
      : null;

    const createdAssignments = await this.prisma.$transaction(async (tx) => {
      if (isMovingSamePortableCooler) {
        await tx.coolerVehicleAssignment.updateMany({
          where: { compartmentId: toCompartment.id, unassignedAt: null },
          data: {
            unassignedAt: transferredAt,
            unassignedById: user.id,
          },
        });
        await tx.coolerVehicleAssignment.create({
          data: {
            compartmentId: toCompartment.id,
            fleetAssetId: dto.toFleetAssetId,
            sensorSlot: assignedDestSlot,
            assignedAt: transferredAt,
            assignedById: user.id,
            notes:
              dto.notes?.trim() ||
              `In-transit cooler transfer onto destination vehicle for delivery ${delivery.id}`,
          },
        });
        await tx.vehicleCompartment.update({
          where: { id: toCompartment.id },
          data: { fleetAssetId: dto.toFleetAssetId },
        });
        const primarySensor = toCompartment.sensors[0];
        if (primarySensor && assignedDestSlot !== null && primarySensor.sensorSlot !== assignedDestSlot) {
          await tx.temperatureDevice.update({
            where: { id: primarySensor.id },
            data: { sensorSlot: assignedDestSlot },
          });
        }
      }

      const destinationRows = [];
      for (const step of transferPlan) {
        const custody = await tx.chainOfCustodyEvent.create({
          data: {
            lotId: step.assignment.lotId,
            deliveryId: delivery.id,
            compartmentId: toCompartment.id,
            fleetAssetId: dto.toFleetAssetId,
            eventType: CustodyEventType.TRANSIT,
            fromUserId: actorUserId,
            toUserId: user.id,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            notes:
              dto.notes ??
              `Vehicle transfer of ${step.transferQty} unit(s) into ${toCompartment.compartmentCode}`,
            occurredAt: transferredAt,
          },
          select: { id: true },
        });

        await tx.cargoCompartmentAssignment.update({
          where: { id: step.assignment.id },
          data: step.fullRemainingTransfer
            ? {
                unloadedAt: transferredAt,
                handoverCustodyEventId: custody.id,
                notes:
                  dto.notes ??
                  `Transferred ${step.transferQty} unit(s) out to compartment ${toCompartment.compartmentCode}`,
              }
            : {
                quantityUnits: step.assignment.quantityUnits - step.transferQty,
                notes:
                  dto.notes ??
                  `Partial transfer of ${step.transferQty} unit(s) out to compartment ${toCompartment.compartmentCode}`,
              },
        });

        const dest = await tx.cargoCompartmentAssignment.create({
          data: {
            deliveryId: delivery.id,
            vendorOrderId: step.assignment.vendorOrderId,
            lotId: step.assignment.lotId,
            fleetAssetId: dto.toFleetAssetId,
            compartmentId: toCompartment.id,
            trackerId: toTracker?.id ?? null,
            sensorDeviceId: resolvedToSensorId,
            quantityUnits: step.transferQty,
            handedOverQuantity: 0,
            loadedAt: transferredAt,
            pickupCustodyEventId: custody.id,
            recordedById: user.id,
            notes: dto.notes ?? `Transferred in (${step.transferQty} units)`,
          },
        });
        destinationRows.push(dest);
      }
      return destinationRows;
    });

      return {
      deliveryId: delivery.id,
      toFleetAssetId: dto.toFleetAssetId,
      toCompartmentId: toCompartment.id,
      toTrackerId: toTracker?.id ?? null,
      toSensorDeviceId: resolvedToSensorId,
      transferredAt,
      createdAssignments,
    };
  }

  async getDeliveryLoadingContext(user: RequestUser, deliveryId: string, now = new Date()) {
    const delivery = await this.assertCanOperateDelivery(user, deliveryId);

    const openAssignmentsRaw = await this.prisma.cargoCompartmentAssignment.findMany({
      where: { deliveryId: delivery.id, unloadedAt: null },
      include: {
        lot: {
          select: { id: true, lotNumber: true, species: true, storageType: true, foodSafetyStatus: true },
        },
        compartment: {
          select: { id: true, compartmentCode: true, coolerCode: true, compartmentKind: true, label: true },
        },
        tracker: { select: { id: true, imei: true } },
        sensorDevice: true,
      },
      orderBy: { loadedAt: 'asc' },
    });

    const referencedVehicleIds = Array.from(new Set(openAssignmentsRaw.map((a) => a.fleetAssetId)));
    const zoneId = delivery.vendorOrder.order.deliveryZoneId;

    const fleetAssets = await this.prisma.fleetAsset.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          ...(delivery.driverId ? [{ currentDriverId: delivery.driverId }] : []),
          ...(referencedVehicleIds.length > 0 ? [{ id: { in: referencedVehicleIds } }] : []),
          ...(zoneId ? [{ zoneId, coldChainCapable: true }] : [{ coldChainCapable: true }]),
        ],
      },
      include: {
        trackers: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, imei: true, hardwareModel: true },
        },
        compartments: {
          where: { active: true },
          include: {
            sensors: {
              where: { status: 'ACTIVE' },
              orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
            },
          },
          orderBy: [{ compartmentKind: 'desc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [{ assetType: 'asc' }, { createdAt: 'asc' }],
    });

    const sortedAssets = [...fleetAssets].sort((a, b) => {
      const aMine = delivery.driverId && a.currentDriverId === delivery.driverId ? 0 : 1;
      const bMine = delivery.driverId && b.currentDriverId === delivery.driverId ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      return a.licensePlate.localeCompare(b.licensePlate);
    });

    return {
      deliveryId: delivery.id,
      vendorOrderId: delivery.vendorOrderId,
      driverId: delivery.driverId,
      fleetAssets: sortedAssets.map((asset) => ({
        id: asset.id,
        licensePlate: asset.licensePlate,
        assetType: asset.assetType,
        status: asset.status,
        trackers: asset.trackers,
        compartments: asset.compartments.map((comp) => ({
          id: comp.id,
          compartmentCode: comp.compartmentCode,
          coolerCode: comp.coolerCode,
          compartmentKind: comp.compartmentKind,
          label: comp.label,
          storageType: comp.storageType,
          sensors: comp.sensors.map((s) => ({
            id: s.id,
            deviceCode: s.deviceCode,
            sensorSlot: s.sensorSlot,
            reportingStatus: computeSensorReportingStatus(s, now),
            lastTemperatureC: s.lastTemperatureC ? Number(s.lastTemperatureC.toString()) : null,
          })),
        })),
      })),
      items: delivery.vendorOrder.items.map((item) => {
        const lot = item.originalLot ?? item.product.lot ?? null;
        return {
          orderItemId: item.id,
          productName: item.productName,
          quantity: item.quantity,
          lotId: item.originalLotId ?? item.product.lotId ?? null,
          lotNumber: lot?.lotNumber ?? null,
          species: lot?.species ?? null,
          storageType: lot?.storageType ?? null,
        };
      }),
      openAssignments: openAssignmentsRaw.map((a) => ({
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
          coolerCode: string | null;
          compartmentKind: CompartmentKind;
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
          coolerCode?: string | null;
          compartmentKind?: CompartmentKind;
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
          coolerCode: comp.coolerCode ?? null,
          compartmentKind: comp.compartmentKind ?? CompartmentKind.FIXED_COMPARTMENT,
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
      const preferredAssignment =
        d.cargoAssignments.find((a) => a.unloadedAt === null) ?? d.cargoAssignments[0];
      const vehicleSummary = preferredAssignment
        ? vehicleMap.get(preferredAssignment.fleetAssetId) ?? null
        : null;
      const matchedCompartment = preferredAssignment
        ? vehicleSummary?.compartments.find((c) => c.id === preferredAssignment.compartmentId)
        : undefined;
      const matchedSensor =
        matchedCompartment?.sensors[0] ?? vehicleSummary?.compartments[0]?.sensors[0] ?? null;
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
        latestCargoTempC: matchedSensor?.lastTemperatureC ?? null,
        sensorReportingStatus: matchedSensor?.reportingStatus ?? null,
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
    const [trackers, sensors, openCargoAssignments, unmatchedFramesRaw, compartments] =
      await Promise.all([
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
                  select: {
                    id: true,
                    licensePlate: true,
                    assetType: true,
                    lastLatitude: true,
                    lastLongitude: true,
                    lastGpsCapturedAt: true,
                    lastTelemetryReceivedAt: true,
                    lastTelemetryDelayed: true,
                    lastGpsNoFixAt: true,
                  },
                },
              },
            },
            vendor: {
              select: { id: true, businessName: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
        typeof this.prisma.cargoCompartmentAssignment?.findMany === 'function'
          ? this.prisma.cargoCompartmentAssignment.findMany({
              where: { unloadedAt: null },
              include: {
                lot: { select: { id: true, lotNumber: true, species: true } },
              },
              orderBy: { loadedAt: 'asc' },
            })
          : Promise.resolve([]),
        typeof this.prisma.vehicleTelemetryFrame?.findMany === 'function'
          ? this.prisma.vehicleTelemetryFrame.findMany({
              where: { unmatchedLot: true },
              include: {
                sensorDevice: { select: { id: true, deviceCode: true } },
                compartment: {
                  select: { id: true, compartmentCode: true, coolerCode: true },
                },
                fleetAsset: { select: { id: true, licensePlate: true } },
              },
              orderBy: { capturedAt: 'desc' },
              take: 25,
            })
          : Promise.resolve([]),
        typeof this.prisma.vehicleCompartment?.findMany === 'function'
          ? this.listCompartments(now)
          : Promise.resolve([]),
      ]);

    const onboardLotsByCompartment = new Map<
      string,
      Array<{
        assignmentId: string;
        lotId: string;
        lotNumber: string;
        species: string;
        quantityUnits: number;
        remainingUnits: number;
        deliveryId: string;
        loadedAt: Date;
      }>
    >();

    for (const a of openCargoAssignments) {
      const list = onboardLotsByCompartment.get(a.compartmentId) ?? [];
      list.push({
        assignmentId: a.id,
        lotId: a.lot.id,
        lotNumber: a.lot.lotNumber,
        species: a.lot.species,
        quantityUnits: a.quantityUnits,
        remainingUnits: Math.max(0, a.quantityUnits - a.handedOverQuantity),
        deliveryId: a.deliveryId,
        loadedAt: a.loadedAt,
      });
      onboardLotsByCompartment.set(a.compartmentId, list);
    }

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
      sensors: sensors.map((s) => {
        const reportingStatus = computeSensorReportingStatus(s, now);
        const vehicleGpsStatus = s.compartment?.fleetAsset
          ? computeVehicleGpsStatus(s.compartment.fleetAsset, now)
          : null;

        let gapClassification:
          | 'NORMAL'
          | 'SENSOR_SIGNAL_MISSING'
          | 'VEHICLE_OFFLINE'
          | 'LTE_BUFFERED_RECOVERY'
          | 'STALE_SENSOR' = 'NORMAL';

        if (reportingStatus === 'SENSOR_SIGNAL_MISSING') {
          gapClassification = 'SENSOR_SIGNAL_MISSING';
        } else if (
          vehicleGpsStatus === 'OFFLINE' ||
          (vehicleGpsStatus === 'STALE' && reportingStatus !== 'REPORTING')
        ) {
          gapClassification = 'VEHICLE_OFFLINE';
        } else if (
          reportingStatus === 'DELAYED' ||
          s.lastGapKind === TelemetryGapKind.LTE_BUFFERED_RECOVERY
        ) {
          gapClassification = 'LTE_BUFFERED_RECOVERY';
        } else if (reportingStatus === 'STALE' || reportingStatus === 'OFFLINE') {
          gapClassification = 'STALE_SENSOR';
        }

        return {
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
          coolerCode: s.compartment?.coolerCode ?? null,
          compartmentKind: s.compartment?.compartmentKind ?? CompartmentKind.FIXED_COMPARTMENT,
          compartmentLabel: s.compartment?.label ?? null,
          storageType: s.compartment?.storageType ?? null,
          fleetAssetId: s.compartment?.fleetAsset?.id ?? null,
          licensePlate: s.compartment?.fleetAsset?.licensePlate ?? null,
          vehicleAssetType: s.compartment?.fleetAsset?.assetType ?? null,
          vehicleGpsStatus,
          vehicleLastGpsCapturedAt: s.compartment?.fleetAsset?.lastGpsCapturedAt ?? null,
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
          reportingStatus,
          gapClassification,
          onboardLots: s.compartmentId ? onboardLotsByCompartment.get(s.compartmentId) ?? [] : [],
        };
      }),
      compartments,
      unmatchedFrames: unmatchedFramesRaw.map((f) => ({
        id: f.id,
        capturedAt: f.capturedAt,
        receivedAt: f.receivedAt,
        cargoTempC: f.cargoTempC ? Number(f.cargoTempC.toString()) : null,
        reason: f.unmatchedReason ?? null,
        sensorId: f.sensorDevice?.id ?? f.sensorDeviceId ?? null,
        sensorDeviceCode: f.sensorDevice?.deviceCode ?? null,
        compartmentId: f.compartment?.id ?? f.compartmentId ?? null,
        compartmentCode: f.compartment?.compartmentCode ?? null,
        coolerCode: f.compartment?.coolerCode ?? null,
        fleetAssetId: f.fleetAsset?.id ?? f.fleetAssetId ?? null,
        licensePlate: f.fleetAsset?.licensePlate ?? null,
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
        fleetAssetId: sensor.compartment?.fleetAsset?.id ?? null,
        licensePlate: sensor.compartment?.fleetAsset?.licensePlate ?? null,
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
        unmatchedLot: f.unmatchedLot,
        unmatchedReason: f.unmatchedReason,
        linkedLotsCount: f.temperatureReadings.length,
        alertsCount: f.temperatureReadings.filter((r) => Boolean(r.alert)).length,
      })),
    };
  }
}
