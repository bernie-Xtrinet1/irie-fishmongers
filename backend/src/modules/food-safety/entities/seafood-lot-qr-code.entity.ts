import { ApiProperty } from '@nestjs/swagger';

export class SeafoodLotQrCodeEntity {
  @ApiProperty({ description: 'The public passport URL encoded by the QR code' })
  passportUrl!: string;

  @ApiProperty({ description: 'Base64 PNG data URI, ready to use as an <img> src for label printing' })
  dataUri!: string;
}
