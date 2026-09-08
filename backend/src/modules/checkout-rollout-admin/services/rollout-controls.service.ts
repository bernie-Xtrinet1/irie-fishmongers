import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CheckoutRolloutParticipantsService,
  assertRolloutUserId,
} from '../../checkout-rollout/services/checkout-rollout-participants.service';
import {
  CreateRolloutControlDto,
  CreateRolloutParticipantDto,
  RolloutHistoryDto,
} from '../dto/rollout-control.dto';
import { RolloutControlsRepository } from '../repositories/rollout-controls.repository';
import { RolloutControlTelemetryService } from './rollout-control-telemetry.service';

@Injectable()
export class RolloutControlsService {
  constructor(
    private readonly repository: RolloutControlsRepository,
    private readonly participants: CheckoutRolloutParticipantsService,
    private readonly telemetry: RolloutControlTelemetryService,
  ) {}

  async current() {
    try {
      const control = await this.repository.findCurrent();
      return control
        ? { status: 'CONFIGURED' as const, control }
        : { status: 'ABSENT' as const, control: null };
    } catch {
      this.telemetry.record('global', 'unavailable');
      return { status: 'UNAVAILABLE' as const, control: null };
    }
  }

  async status() {
    const current = await this.current();
    return {
      ...current,
      newAdmissionStopped: current.control?.newAdmissionStopped ?? null,
      productionDispatcherActive: false as const,
      legacyEndpointAffected: false as const,
    };
  }

  async append(actorId: string, input: CreateRolloutControlDto) {
    try {
      assertRolloutUserId(actorId);
      const dto = plainToInstance(CreateRolloutControlDto, input);
      if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
        throw new BadRequestException('Invalid rollout control revision');
      const result = await this.repository.appendIfCurrent(actorId, dto);
      if (!result.ok) {
        if (result.code === 'STALE_REVISION')
          throw new ConflictException('Control revision changed; reload before retrying');
        throw new NotFoundException('Actor not found');
      }
      this.telemetry.record('global', 'success');
      return result.control;
    } catch (error) {
      this.telemetry.record('global', error instanceof ConflictException ? 'conflict' : 'failure');
      throw error;
    }
  }

  history(query: RolloutHistoryDto) {
    const dto = plainToInstance(RolloutHistoryDto, query);
    if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
      throw new BadRequestException('Invalid history cursor or page size (maximum 200)');
    return this.repository.listHistory(dto.afterRevision, dto.limit);
  }

  async setParticipant(customerId: string, actorId: string, input: CreateRolloutParticipantDto) {
    try {
      const dto = plainToInstance(CreateRolloutParticipantDto, input);
      if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
        throw new BadRequestException('Invalid participation revision');
      const result = await this.participants.setParticipation(customerId, actorId, dto);
      this.telemetry.record('participant', 'success');
      return result;
    } catch (error) {
      this.telemetry.record(
        'participant',
        error instanceof ConflictException ? 'conflict' : 'failure',
      );
      throw error;
    }
  }
}
