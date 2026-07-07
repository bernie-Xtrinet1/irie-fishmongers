import { ApiProperty } from '@nestjs/swagger';

export class PreferenceResponseEntity {
  @ApiProperty()
  emailEnabled!: boolean;

  @ApiProperty()
  pushEnabled!: boolean;

  @ApiProperty()
  accountEnabled!: boolean;

  @ApiProperty()
  vendorEnabled!: boolean;

  @ApiProperty()
  orderUpdatesEnabled!: boolean;

  @ApiProperty()
  paymentUpdatesEnabled!: boolean;

  @ApiProperty()
  deliveryUpdatesEnabled!: boolean;
}
