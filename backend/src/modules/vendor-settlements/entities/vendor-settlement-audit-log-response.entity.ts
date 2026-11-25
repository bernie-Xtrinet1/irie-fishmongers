import { ApiProperty } from '@nestjs/swagger';
import { VendorSettlementAuditAction, VendorSettlementStatus } from '@prisma/client';

export class VendorSettlementAuditLogResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  settlementId!: string;

  @ApiProperty()
  actorUserId!: string;

  @ApiProperty()
  actorEmail!: string;

  @ApiProperty({ enum: VendorSettlementAuditAction })
  action!: VendorSettlementAuditAction;

  @ApiProperty({ enum: VendorSettlementStatus })
  previousStatus!: VendorSettlementStatus;

  @ApiProperty({ enum: VendorSettlementStatus })
  newStatus!: VendorSettlementStatus;

  @ApiProperty({ required: false, nullable: true })
  paymentReference!: string | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
