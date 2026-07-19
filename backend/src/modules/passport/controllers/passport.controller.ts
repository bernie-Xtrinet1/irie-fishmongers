import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { DigitalProductPassportEntity } from '../entities/digital-product-passport.entity';
import { PassportService } from '../services/passport.service';

// Public, no auth - the whole point of a QR-scannable Digital Product
// Passport. Looked up by the non-enumerable publicTraceToken, never by
// lot id or the sequential/enumerable lotNumber.
@ApiTags('passport')
@Controller('passport')
export class PassportController {
  constructor(private readonly passportService: PassportService) {}

  @Get(':token')
  @ApiOperation({ summary: "Get a seafood lot's public Digital Product Passport by its trace token" })
  @ApiResponseDoc({ status: 200, type: DigitalProductPassportEntity })
  getByToken(@Param('token') token: string): Promise<DigitalProductPassportEntity> {
    return this.passportService.getByToken(token);
  }
}
