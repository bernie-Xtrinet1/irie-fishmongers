import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  AuthorizeGatewayImeiDto,
  IngestCanonicalTelemetryDto,
  IngestCodec8eHttpDto,
  IngestCodecJsonTelemetryDto,
} from '../dto/telemetry.dto';
import {
  TelemetryAuthenticatedRequest,
  TelemetryGatewayAuthGuard,
} from '../guards/telemetry-gateway-auth.guard';
import {
  TelemetryIngestionService,
  TelemetryIngestSummary,
} from '../services/telemetry-ingestion.service';

@ApiTags('telemetry-ingestion')
@ApiHeader({
  name: 'X-Telemetry-Key',
  description: 'Dedicated device or telemetry gateway credential (user JWTs are rejected)',
  required: true,
})
@UseGuards(TelemetryGatewayAuthGuard)
@Controller('telemetry')
export class TelemetryIngestionController {
  constructor(private readonly ingestionService: TelemetryIngestionService) {}

  @Post('authorize-imei')
  @ApiOperation({
    summary: 'Verify that a Teltonika tracker IMEI is actively enrolled before accepting TCP packets',
  })
  authorizeImei(
    @Req() req: TelemetryAuthenticatedRequest,
    @Body() dto: AuthorizeGatewayImeiDto,
  ): Promise<{ authorized: boolean; trackerId?: string }> {
    return this.ingestionService.authorizeGatewayImei(req.telemetryAuth!, dto.imei);
  }

  @Post('codec8e')
  @ApiOperation({
    summary: 'Ingest a Teltonika FMC130 binary Codec 8 Extended (0x8E) AVL packet',
  })
  ingestCodec8e(
    @Req() req: TelemetryAuthenticatedRequest,
    @Body() dto: IngestCodec8eHttpDto,
  ): Promise<TelemetryIngestSummary> {
    return this.ingestionService.ingestCodec8e(req.telemetryAuth!, dto);
  }

  @Post('codec-json')
  @ApiOperation({
    summary: 'Ingest a Teltonika Codec JSON payload (e.g., from MQTT / Azure IoT Hub bridge)',
  })
  ingestCodecJson(
    @Req() req: TelemetryAuthenticatedRequest,
    @Body() dto: IngestCodecJsonTelemetryDto,
  ): Promise<TelemetryIngestSummary> {
    return this.ingestionService.ingestCodecJson(req.telemetryAuth!, dto);
  }

  @Post('ingest')
  @ApiOperation({
    summary: 'Ingest canonical HTTP JSON vehicle GPS and cargo-air temperature records',
  })
  ingestCanonical(
    @Req() req: TelemetryAuthenticatedRequest,
    @Body() dto: IngestCanonicalTelemetryDto,
  ): Promise<TelemetryIngestSummary> {
    return this.ingestionService.ingestCanonicalHttp(req.telemetryAuth!, dto);
  }
}
