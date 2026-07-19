import { ApiProperty } from '@nestjs/swagger';

export class ResolvedZoneEntity {
  @ApiProperty({ nullable: true, description: 'null when the parish has no zone mapping yet' })
  zoneId!: string | null;
}
