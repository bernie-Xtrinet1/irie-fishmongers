import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';

export class UpdateCataloguePhotoStaffAccessDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetUserId!: string;

  @ApiProperty()
  @IsBoolean()
  canManageCataloguePhotos!: boolean;
}
