import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { AddListingPhotoDto } from '../dto/add-listing-photo.dto';
import { CreateDailyListingDto } from '../dto/create-daily-listing.dto';
import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';
import { RepeatDailyListingDto } from '../dto/repeat-daily-listing.dto';
import { UpdateDailyListingDto } from '../dto/update-daily-listing.dto';
import { WithdrawDailyListingDto } from '../dto/withdraw-daily-listing.dto';
import { WithdrawListingPhotoDto } from '../dto/withdraw-listing-photo.dto';
import { DailyListingResponseEntity } from '../entities/daily-listing-response.entity';
import { ListingPhotoResponseEntity } from '../entities/listing-photo-response.entity';
import { PaginatedDailyListingsEntity } from '../entities/paginated-daily-listings.entity';
import { DailyListingsService } from '../services/daily-listings.service';

@ApiTags('vendor/daily-listings')
@Controller('vendor/daily-listings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.VENDOR)
@ApiBearerAuth()
export class VendorDailyListingsController {
  constructor(private readonly dailyListingsService: DailyListingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new daily seafood listing in DRAFT status' })
  @ApiResponseDoc({ status: 201, type: DailyListingResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List daily listings for the authenticated vendor' })
  @ApiResponseDoc({ status: 200, type: PaginatedDailyListingsEntity })
  findMyListings(
    @CurrentUser() user: RequestUser,
    @Query() query: QueryDailyListingsDto,
  ): Promise<PaginatedDailyListingsEntity> {
    return this.dailyListingsService.findMyListings(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a daily listing owned by vendor' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  findOne(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.findOwnedById(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a draft daily listing' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.update(user.id, id, dto);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish a draft daily listing to Available Today after regulatory checks' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  publish(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.publish(user.id, id);
  }

  @Post(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw an active or draft daily listing from sale' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  withdraw(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: WithdrawDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.withdraw(user.id, id, dto);
  }

  @Post(':id/repeat')
  @ApiOperation({ summary: 'Repeat a previous listing with new daily catch parameters (fresh lot, date, price, qty)' })
  @ApiResponseDoc({ status: 201, type: DailyListingResponseEntity })
  repeat(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RepeatDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.repeat(user.id, id, dto);
  }

  @Post(':id/photos')
  @ApiOperation({ summary: 'Add an actual-catch photograph to this daily listing' })
  @ApiResponseDoc({ status: 201, type: ListingPhotoResponseEntity })
  addPhoto(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: AddListingPhotoDto,
  ): Promise<ListingPhotoResponseEntity> {
    return this.dailyListingsService.addPhoto(user.id, id, dto);
  }

  @Delete(':id/photos/:photoId')
  @ApiOperation({ summary: 'Soft-delete/withdraw a photograph from this listing (retains evidence provenance)' })
  @ApiResponseDoc({ status: 200, type: ListingPhotoResponseEntity })
  withdrawPhoto(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Body() dto: WithdrawListingPhotoDto,
  ): Promise<ListingPhotoResponseEntity> {
    return this.dailyListingsService.withdrawPhoto(user.id, id, photoId, dto);
  }

  @Patch(':id/photos/:photoId/primary')
  @ApiOperation({ summary: 'Designate a photograph as the primary image for this listing' })
  @ApiResponseDoc({ status: 200, type: ListingPhotoResponseEntity })
  setPrimaryPhoto(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ): Promise<ListingPhotoResponseEntity> {
    return this.dailyListingsService.setPrimaryPhoto(user.id, id, photoId);
  }
}
