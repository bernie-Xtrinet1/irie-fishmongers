import { ApiProperty } from '@nestjs/swagger';
import { DeliveryExceptionType, Parish } from '@prisma/client';

// Enriched form of DeliveryExceptionResponseEntity for the admin dispatcher
// list (10B: Delivery Operations Center) - adds the vendor/customer/driver/
// address context a dispatcher needs without a second lookup per row. The
// driver-report POST endpoint keeps returning the plain
// DeliveryExceptionResponseEntity; only the admin GET /delivery/exceptions
// list uses this shape.
export class DeliveryExceptionWithContextEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deliveryId!: string;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty({ enum: DeliveryExceptionType })
  type!: DeliveryExceptionType;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: [String] })
  photos!: string[];

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  resolved!: boolean;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  resolvedById!: string | null;

  @ApiProperty()
  vendorBusinessName!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty()
  deliveryAddressLine1!: string;

  @ApiProperty({ enum: Parish })
  deliveryParish!: Parish;

  @ApiProperty()
  driverName!: string;

  @ApiProperty()
  createdAt!: Date;
}
