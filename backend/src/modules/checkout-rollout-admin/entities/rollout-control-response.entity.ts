import { ApiProperty } from '@nestjs/swagger';
import { CheckoutRolloutBehavior } from '@prisma/client';

export class RolloutRevisionEntity {
  @ApiProperty() id!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() actorId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() createdAt!: Date;
}
export class RolloutControlEntity extends RolloutRevisionEntity {
  @ApiProperty() newAdmissionStopped!: boolean;
  @ApiProperty({ enum: CheckoutRolloutBehavior }) behavior!: CheckoutRolloutBehavior;
  @ApiProperty({ type: String, nullable: true }) eligibleCohort!: string | null;
}
export class RolloutParticipantEntity extends RolloutRevisionEntity {
  @ApiProperty() customerId!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) cohort!: string | null;
}
export class RolloutStatusEntity {
  @ApiProperty({ enum: ['CONFIGURED', 'ABSENT', 'UNAVAILABLE'] }) status!:
    'CONFIGURED' | 'ABSENT' | 'UNAVAILABLE';
  @ApiProperty({ type: RolloutControlEntity, nullable: true })
  control!: RolloutControlEntity | null;
  @ApiProperty({ type: Boolean, nullable: true }) newAdmissionStopped!: boolean | null;
  @ApiProperty({ enum: [false] }) productionDispatcherActive!: false;
  @ApiProperty({ enum: [false] }) legacyEndpointAffected!: false;
}
export class RolloutParticipantStatusEntity {
  @ApiProperty({ enum: ['CONFIGURED', 'ABSENT'] }) status!: 'CONFIGURED' | 'ABSENT';
  @ApiProperty({ type: RolloutParticipantEntity, nullable: true })
  participant!: RolloutParticipantEntity | null;
}
