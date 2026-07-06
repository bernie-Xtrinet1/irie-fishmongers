import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Request } from 'express';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RefundPaymentDto } from '../dto/refund-payment.dto';
import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { RefundResponseEntity } from '../entities/refund-response.entity';
import { PaymentsService } from '../services/payments.service';

const WIPAY_SIGNATURE_HEADER = 'x-wipay-signature';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('webhooks/wipay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive WiPay payment.success / payment.failed callbacks' })
  async wiPayWebhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const signature = req.headers[WIPAY_SIGNATURE_HEADER];
    if (!req.rawBody || typeof signature !== 'string') {
      throw new BadRequestException('Missing webhook body or signature');
    }

    await this.paymentsService.handleWiPayWebhook(req.rawBody.toString('utf8'), signature);
    return { received: true };
  }

  @Patch(':id/mark-paid')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm a cash-on-delivery payment was collected (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaymentResponseEntity })
  markCashOnDeliveryPaid(@Param('id') id: string): Promise<PaymentResponseEntity> {
    return this.paymentsService.markCashOnDeliveryPaid(id);
  }

  @Post(':id/refund')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue a full or partial refund for exceptional circumstances (admin only)' })
  @ApiResponseDoc({ status: 201, type: RefundResponseEntity })
  refund(
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
  ): Promise<RefundResponseEntity> {
    return this.paymentsService.refundByPaymentId(id, dto.amount, dto.reason);
  }
}
