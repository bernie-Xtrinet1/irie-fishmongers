import { ApiProperty } from '@nestjs/swagger';
import { VendorOrderStatus } from '@prisma/client';

export class PickupQueueEntryEntity {
  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty({ enum: VendorOrderStatus })
  status!: VendorOrderStatus;

  @ApiProperty({ required: false, nullable: true })
  driverName!: string | null;

  @ApiProperty({ required: false, nullable: true, description: "The driver's estimated pickup arrival window" })
  scheduledPickupWindowStart!: Date | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Position in the driver route sequence; null until grouped into a DeliveryRun',
  })
  pickupOrder!: number | null;
}
