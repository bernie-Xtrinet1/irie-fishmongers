import { ApiProperty } from '@nestjs/swagger';
import { AlertSeverity, DriverStatus, VendorOrderStatus, VendorStatus } from '@prisma/client';

export class FinancialsEntity {
  @ApiProperty({ description: 'sum(Payment.amount) where status=PAID - gross payment volume, not net platform revenue' })
  grossPaidAmount!: string;

  @ApiProperty({ description: 'sum(VendorSettlement.platformFee) where status=PAID - the platform\'s actual earned commission' })
  platformCommission!: string;

  @ApiProperty({ example: 'JMD' })
  currency!: 'JMD';
}

class VendorOrdersByStatusEntity implements Record<VendorOrderStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  ACCEPTED!: number;

  @ApiProperty()
  PREPARING!: number;

  @ApiProperty()
  READY_FOR_PICKUP!: number;

  @ApiProperty()
  ASSIGNED_TO_DRIVER!: number;

  @ApiProperty()
  IN_TRANSIT!: number;

  @ApiProperty()
  DELIVERED!: number;

  @ApiProperty()
  DELIVERY_FAILED!: number;

  @ApiProperty()
  REJECTED!: number;

  @ApiProperty()
  CANCELLED!: number;
}

export class OrderCountsEntity {
  @ApiProperty({ description: 'count(Order) - parent orders, distinct from the per-vendor breakdown below' })
  customerOrdersTotal!: number;

  @ApiProperty({
    type: VendorOrdersByStatusEntity,
    description:
      'NOT "orders by status" - one customer Order split across multiple vendors counts once per VendorOrder',
  })
  vendorOrdersByStatus!: VendorOrdersByStatusEntity;
}

class VendorsByStatusEntity implements Record<VendorStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  APPROVED!: number;

  @ApiProperty()
  SUSPENDED!: number;

  @ApiProperty()
  REJECTED!: number;
}

export class VendorCountsEntity {
  @ApiProperty({ type: VendorsByStatusEntity })
  byStatus!: VendorsByStatusEntity;
}

class DriversByStatusEntity implements Record<DriverStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  APPROVED!: number;

  @ApiProperty()
  SUSPENDED!: number;

  @ApiProperty()
  REJECTED!: number;
}

export class DriverCountsEntity {
  @ApiProperty({ type: DriversByStatusEntity })
  byStatus!: DriversByStatusEntity;
}

class AlertsBySeverityEntity implements Record<AlertSeverity, number> {
  @ApiProperty()
  WARNING!: number;

  @ApiProperty()
  CRITICAL!: number;

  @ApiProperty()
  EMERGENCY!: number;
}

export class ComplianceSummaryEntity {
  @ApiProperty({ type: AlertsBySeverityEntity })
  activeAlertsBySeverity!: AlertsBySeverityEntity;

  @ApiProperty()
  activeRecalls!: number;
}

export class SystemHealthEntity {
  @ApiProperty({ enum: ['up', 'down'] })
  postgres!: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'] })
  redis!: 'up' | 'down';
}

export class DashboardSummaryEntity {
  @ApiProperty({ type: FinancialsEntity })
  financials!: FinancialsEntity;

  @ApiProperty({ type: OrderCountsEntity })
  orders!: OrderCountsEntity;

  @ApiProperty({
    type: VendorCountsEntity,
    description: 'Point-in-time snapshot - ignores the from/to range',
  })
  vendors!: VendorCountsEntity;

  @ApiProperty({
    type: DriverCountsEntity,
    description: 'Point-in-time snapshot - ignores the from/to range',
  })
  drivers!: DriverCountsEntity;

  @ApiProperty({
    type: ComplianceSummaryEntity,
    description: 'Point-in-time snapshot - ignores the from/to range',
  })
  compliance!: ComplianceSummaryEntity;

  @ApiProperty({ type: SystemHealthEntity })
  systemHealth!: SystemHealthEntity;
}
