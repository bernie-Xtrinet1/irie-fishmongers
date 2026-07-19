import { BadRequestException, Injectable } from '@nestjs/common';

import { CreateCustodyEventDto } from '../dto/create-custody-event.dto';
import { CustodyEventResponseEntity } from '../entities/custody-event-response.entity';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';

// The "no gaps allowed" traceability chain log (seafood-compliance-
// rules.md). fromUserId/toUserId record who custody actually transferred
// between, not just who logged the event - both nullable since some event
// types only have one side (LANDING has no upstream User, DISPOSAL has no
// downstream recipient).
@Injectable()
export class CustodyEventsService {
  constructor(private readonly custodyEventsRepository: CustodyEventsRepository) {}

  record(dto: CreateCustodyEventDto): Promise<CustodyEventResponseEntity> {
    if (!dto.catchId && !dto.lotId) {
      throw new BadRequestException('At least one of catchId or lotId must be set');
    }
    return this.custodyEventsRepository.create(dto);
  }

  list(filters: { catchId?: string; lotId?: string }): Promise<CustodyEventResponseEntity[]> {
    return this.custodyEventsRepository.findMany(filters);
  }
}
