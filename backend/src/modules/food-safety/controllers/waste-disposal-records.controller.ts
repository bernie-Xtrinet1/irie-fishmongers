import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateWasteDisposalRecordDto } from '../dto/create-waste-disposal-record.dto';
import { ListWasteDisposalRecordsDto } from '../dto/list-waste-disposal-records.dto';
import { WasteDisposalRecordResponseEntity } from '../entities/waste-disposal-record-response.entity';
import { WasteDisposalRecordsService } from '../services/waste-disposal-records.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('food-safety/waste-disposal-records')
export class WasteDisposalRecordsController {
  constructor(private readonly wasteDisposalRecordsService: WasteDisposalRecordsService) {}

  @Post()
  @Roles(RoleName.VENDOR, RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Record the disposal of seafood waste for a lot (owning vendor or admin)' })
  @ApiResponseDoc({ status: 201, type: WasteDisposalRecordResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWasteDisposalRecordDto,
  ): Promise<WasteDisposalRecordResponseEntity> {
    return this.wasteDisposalRecordsService.create(user, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List waste disposal records, optionally filtered by lot or recall (admin only)' })
  @ApiResponseDoc({ status: 200, type: WasteDisposalRecordResponseEntity, isArray: true })
  list(@Query() dto: ListWasteDisposalRecordsDto): Promise<WasteDisposalRecordResponseEntity[]> {
    return this.wasteDisposalRecordsService.list(dto);
  }
}
