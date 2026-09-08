import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CheckoutRolloutParticipantsService } from '../../checkout-rollout/services/checkout-rollout-participants.service';
import {
  CreateRolloutControlDto,
  CreateRolloutParticipantDto,
  RolloutHistoryDto,
} from '../dto/rollout-control.dto';
import {
  RolloutControlEntity,
  RolloutParticipantEntity,
  RolloutParticipantStatusEntity,
  RolloutStatusEntity,
} from '../entities/rollout-control-response.entity';
import { RolloutControlsService } from '../services/rollout-controls.service';

@ApiTags('checkout-rollout')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('checkout-rollout')
export class RolloutAdminController {
  constructor(
    private readonly controls: RolloutControlsService,
    private readonly participants: CheckoutRolloutParticipantsService,
  ) {}

  @Post('control-revisions')
  @ApiResponse({ status: 201, type: RolloutControlEntity })
  @ApiResponse({ status: 409, description: 'Stale expected revision' })
  append(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRolloutControlDto,
  ): Promise<RolloutControlEntity> {
    return this.controls.append(user.id, dto);
  }

  @Get('status')
  @ApiResponse({ status: 200, type: RolloutStatusEntity })
  status(): Promise<RolloutStatusEntity> {
    return this.controls.status();
  }

  @Get('control-revisions')
  @ApiResponse({ status: 200, type: [RolloutControlEntity] })
  history(@Query() query: RolloutHistoryDto): Promise<RolloutControlEntity[]> {
    return this.controls.history(query);
  }

  @Post('participants/:customerId/revisions')
  @ApiResponse({ status: 201, type: RolloutParticipantEntity })
  @ApiResponse({ status: 409, description: 'Stale expected revision' })
  setParticipant(
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRolloutParticipantDto,
  ): Promise<RolloutParticipantEntity> {
    return this.controls.setParticipant(customerId, user.id, dto);
  }

  @Get('participants/:customerId')
  @ApiResponse({ status: 200, type: RolloutParticipantStatusEntity })
  async participant(
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<RolloutParticipantStatusEntity> {
    // Lookup errors propagate as errors; they are never reported as absent membership.
    const participant = await this.participants.getParticipant(customerId);
    return { status: participant ? 'CONFIGURED' : 'ABSENT', participant };
  }

  @Get('participants/:customerId/revisions')
  @ApiResponse({ status: 200, type: [RolloutParticipantEntity] })
  participantHistory(
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Query() query: RolloutHistoryDto,
  ): Promise<RolloutParticipantEntity[]> {
    return this.participants.listHistory(customerId, query.afterRevision, query.limit);
  }
}
