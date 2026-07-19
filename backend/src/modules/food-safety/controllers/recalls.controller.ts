import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Request } from 'express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateRecallDto } from '../dto/create-recall.dto';
import { ListRecallsDto } from '../dto/list-recalls.dto';
import { UpdateRecallStatusDto } from '../dto/update-recall-status.dto';
import { AffectedOrderEntity } from '../entities/affected-order.entity';
import { PaginatedRecallsEntity } from '../entities/paginated-recalls.entity';
import { RecallResponseEntity } from '../entities/recall-response.entity';
import { RecallsService } from '../services/recalls.service';

@ApiTags('recalls')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('recalls')
export class RecallsController {
  constructor(private readonly recallsService: RecallsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a recall for one or more seafood lots (admin only)' })
  @ApiResponseDoc({ status: 201, type: RecallResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRecallDto,
  ): Promise<RecallResponseEntity> {
    return this.recallsService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List recalls, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedRecallsEntity })
  list(@Query() dto: ListRecallsDto): Promise<PaginatedRecallsEntity> {
    return this.recallsService.list(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a recall by id (admin only)' })
  @ApiResponseDoc({ status: 200, type: RecallResponseEntity })
  getById(@Param('id') id: string): Promise<RecallResponseEntity> {
    return this.recallsService.getById(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Advance a recall through Draft -> Active -> Investigating -> Resolved -> Closed (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: RecallResponseEntity })
  updateStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateRecallStatusDto,
    @Req() req: Request,
  ): Promise<RecallResponseEntity> {
    return this.recallsService.updateStatus(user.id, id, dto, req.ip);
  }

  @Get(':id/affected-orders')
  @ApiOperation({ summary: 'List orders/customers affected by a recall (admin only)' })
  @ApiResponseDoc({ status: 200, type: AffectedOrderEntity, isArray: true })
  getAffectedOrders(@Param('id') id: string): Promise<AffectedOrderEntity[]> {
    return this.recallsService.getAffectedOrders(id);
  }
}
