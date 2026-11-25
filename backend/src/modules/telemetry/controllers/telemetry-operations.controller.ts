import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  CreateVehicleCompartmentDto,
  ImportEyeAppCsvDto,
  IssueTelemetryCredentialDto,
  ListTelemetryHistoryQueryDto,
  RecordCompartmentHandoverDto,
  RecordCompartmentPickupDto,
  RegisterCargoSensorDto,
  RegisterVehicleTrackerDto,
  RevokeTelemetryCredentialDto,
  RotateTelemetryCredentialDto,
} from '../dto/telemetry.dto';
import {
  IssuedTelemetryCredentialResult,
  SafeTelemetryCredentialView,
  TelemetryCredentialsService,
} from '../services/telemetry-credentials.service';
import {
  EyeCsvImportSummary,
  TelemetryIngestionService,
} from '../services/telemetry-ingestion.service';
import { TelemetryOperationsService } from '../services/telemetry-operations.service';

@ApiTags('telemetry-operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('telemetry')
export class TelemetryOperationsController {
  constructor(
    private readonly opsService: TelemetryOperationsService,
    private readonly credentialsService: TelemetryCredentialsService,
    private readonly ingestionService: TelemetryIngestionService,
  ) {}

  @Post('compartments')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Register a cold-chain cargo compartment on a fleet vehicle (admin only)' })
  createCompartment(@Body() dto: CreateVehicleCompartmentDto) {
    return this.opsService.createCompartment(dto);
  }

  @Post('trackers')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Enroll a Teltonika FMC130 tracker against a fleet vehicle (admin only)' })
  registerTracker(@Body() dto: RegisterVehicleTrackerDto) {
    return this.opsService.registerTracker(dto);
  }

  @Post('sensors')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Bind an EYE Sensor BTSMP1 probe to a vehicle compartment (admin only)' })
  registerSensor(@Body() dto: RegisterCargoSensorDto) {
    return this.opsService.registerCargoSensor(dto);
  }

  @Post('credentials')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Issue a dedicated device or gateway telemetry credential (admin only)' })
  issueCredential(
    @CurrentUser() user: RequestUser,
    @Body() dto: IssueTelemetryCredentialDto,
  ): Promise<IssuedTelemetryCredentialResult> {
    return this.credentialsService.issue(user.id, dto);
  }

  @Get('credentials')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List registered telemetry credentials without secret hashes (admin only)' })
  listCredentials(@Query('trackerId') trackerId?: string): Promise<SafeTelemetryCredentialView[]> {
    return this.credentialsService.list(trackerId);
  }

  @Post('credentials/:id/rotate')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Rotate a telemetry credential with an overlap grace window (admin only)' })
  rotateCredential(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RotateTelemetryCredentialDto,
  ): Promise<IssuedTelemetryCredentialResult> {
    return this.credentialsService.rotate(user.id, id, dto.graceMinutes ?? 60);
  }

  @Patch('credentials/:id/revoke')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Immediately revoke a device or gateway telemetry credential (admin only)' })
  revokeCredential(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RevokeTelemetryCredentialDto,
  ): Promise<SafeTelemetryCredentialView> {
    return this.credentialsService.revoke(user.id, id, dto.reason);
  }

  @Get('overview/active-runs')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'Get live GPS vehicle positions, active runs, and stale/delayed flags' })
  getActiveRunsLiveOverview() {
    return this.opsService.getActiveRunsLiveOverview();
  }

  @Get('overview/devices')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'List enrolled trackers, compartments, and EYE sensors with live health status' })
  getTelemetryDevicesOverview() {
    return this.opsService.getTelemetryDevicesOverview();
  }

  @Get('sensors/:sensorId/history')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'Inspect recent temperature readings, gaps, and EYE CSV recovery logs for a sensor' })
  getSensorHistory(
    @Param('sensorId') sensorId: string,
    @Query() query: ListTelemetryHistoryQueryDto,
  ) {
    return this.opsService.getSensorTelemetryHistory(sensorId, query);
  }

  @Post('sensors/:sensorId/csv-recovery')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({ summary: 'Upload an EYE App EN12830 CSV export as a separate recovery telemetry source' })
  importEyeAppCsv(
    @Param('sensorId') sensorId: string,
    @Body() dto: ImportEyeAppCsvDto,
  ): Promise<EyeCsvImportSummary> {
    return this.ingestionService.importEyeAppCsvRecovery(sensorId, dto);
  }

  @Get('deliveries/:deliveryId')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF, RoleName.DRIVER)
  @ApiOperation({
    summary:
      'Inspect Active Delivery Details: vehicle, compartment, onboard lots, manual vs cargo-air checks, alerts & gaps',
  })
  getDeliveryTelemetryDetail(
    @CurrentUser() user: RequestUser,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.opsService.getDeliveryTelemetryDetail(user, deliveryId);
  }

  @Post('cargo/pickup')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF, RoleName.DRIVER)
  @ApiOperation({
    summary: 'Record custody-linked pickup loading onto a vehicle compartment and tracker/sensor pair',
  })
  recordPickup(
    @CurrentUser() user: RequestUser,
    @Body() dto: RecordCompartmentPickupDto,
  ) {
    return this.opsService.recordCompartmentPickup(user, dto);
  }

  @Post('cargo/handover')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF, RoleName.DRIVER)
  @ApiOperation({
    summary: 'Record partial or full cargo handover from a vehicle compartment, closing completed lots',
  })
  recordHandover(
    @CurrentUser() user: RequestUser,
    @Body() dto: RecordCompartmentHandoverDto,
  ) {
    return this.opsService.recordCompartmentHandover(user, dto);
  }
}
