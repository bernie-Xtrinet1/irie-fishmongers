import { ApiProperty } from '@nestjs/swagger';

export class RegulatoryAuthorityResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ required: false, nullable: true })
  country!: string | null;

  @ApiProperty({ required: false, nullable: true })
  contactEmail!: string | null;

  @ApiProperty({ required: false, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ required: false, nullable: true })
  website!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
