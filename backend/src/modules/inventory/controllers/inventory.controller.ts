import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ReconcileInventoryDto } from '../dto/reconcile-inventory.dto';
import { PaginatedInventoryEventsEntity } from '../entities/paginated-inventory-events.entity';
import { ReconciliationResultEntity } from '../entities/reconciliation-result.entity';
import { InventoryEventsRepository } from '../repositories/inventory-events.repository';
import { InventoryReconciliationService } from '../services/inventory-reconciliation.service';

@ApiTags('inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly eventsRepository: InventoryEventsRepository,
    private readonly reconciliationService: InventoryReconciliationService,
  ) {}

  @Get(':productId/events')
  @ApiOperation({ summary: 'List the durable inventory audit trail for a product (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedInventoryEventsEntity })
  async getEvents(
    @Param('productId') productId: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedInventoryEventsEntity> {
    const { items, total } = await this.eventsRepository.findByProduct(productId, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });
    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  @Post('reconcile')
  @ApiOperation({
    summary:
      'Cross-check Redis reservations against live cart items and release any orphaned holds (admin only)',
  })
  @ApiResponseDoc({ status: 201, type: ReconciliationResultEntity })
  reconcile(@Query() dto: ReconcileInventoryDto): Promise<ReconciliationResultEntity> {
    return this.reconciliationService.reconcile(dto.productId);
  }
}
