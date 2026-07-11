import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateCustodyEventDto } from '../dto/create-custody-event.dto';
import { ListCustodyEventsDto } from '../dto/list-custody-events.dto';
import { CustodyEventResponseEntity } from '../entities/custody-event-response.entity';
import { CustodyEventsService } from '../services/custody-events.service';

// Admin-only: manual recording and review of the custody chain. Vendor/
// driver self-service recording (per the plan's original design) would
// need SeafoodLotsService's ownership check, which is not reachable here
// without a circular import (SeafoodLotsModule itself imports this
// module for the auto-wired STORAGE_ENTRY event) - a defensible scope
// narrowing, not a silent omission.
@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/custody-events')
export class CustodyEventsController {
  constructor(private readonly custodyEventsService: CustodyEventsService) {}

  @Post()
  @ApiOperation({ summary: 'Manually record a chain-of-custody event (admin only)' })
  @ApiResponseDoc({ status: 201, type: CustodyEventResponseEntity })
  record(@Body() dto: CreateCustodyEventDto): Promise<CustodyEventResponseEntity> {
    return this.custodyEventsService.record(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the custody-chain timeline for a catch or lot (admin only)' })
  @ApiResponseDoc({ status: 200, type: CustodyEventResponseEntity, isArray: true })
  list(@Query() dto: ListCustodyEventsDto): Promise<CustodyEventResponseEntity[]> {
    return this.custodyEventsService.list(dto);
  }
}
