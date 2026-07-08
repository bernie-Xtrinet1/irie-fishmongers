import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateDriverProfileDto {
  @ApiProperty({
    required: false,
    example: 500,
    description: 'Maximum load capacity in pounds',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacityLbs?: number;

  @ApiProperty({
    required: false,
    description: "Whether the driver's vehicle can maintain cold-chain temperature requirements",
  })
  @IsOptional()
  @IsBoolean()
  coldChainCapable?: boolean;
}
