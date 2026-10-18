import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';
import { RedisModule } from '../../common/redis/redis.module';
import { RedisService } from '../../common/redis/redis.service';

import { ReservationFenceRepository } from './repositories/reservation-fence.repository';
import { OrdinaryInvalidationRepository } from './repositories/ordinary-invalidation.repository';
import { OrdinaryReservationCommandRepository } from './repositories/ordinary-reservation-command.repository';
import { OrdinaryCommandPhysicalService } from './services/ordinary-command-physical.service';
import { OrdinaryCommandClosureService } from './services/ordinary-command-closure.service';
import { OrdinaryInvalidationService } from './services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from './services/ordinary-invalidation-publication.service';
import { OrdinaryRecoveryRegistryService } from './services/ordinary-recovery-registry.service';
import { OrdinaryMarkerBootstrapService } from './services/ordinary-marker-bootstrap.service';
import { OrdinaryInvalidationRecoveryService } from './services/ordinary-invalidation-recovery.service';
import { OrdinaryRecoverySweepWorker } from './workers/ordinary-recovery-sweep.worker';
import { OrdinaryRecoveryDiagnosticsService } from './services/ordinary-recovery-diagnostics.service';
import { OrdinaryCommandRecoveryService } from './services/ordinary-command-recovery.service';
import { OrdinaryCommandRecoverySweepWorker } from './workers/ordinary-command-recovery-sweep.worker';
import { OrdinaryRecoveryCoordinatorService } from './services/ordinary-recovery-coordinator.service';
import { OrdinaryRecoveryTelemetryAdapter } from './services/ordinary-recovery-telemetry-adapter.service';

/**
 * Phase C.3.5 — Dedicated Dormant Ordinary Recovery Module (Option DI-C).
 *
 * Encapsulates the entire ordinary recovery dependency tree within an independent,
 * dormant NestJS module without importing the active fence module.
 *
 * Invariants & Isolation Properties:
 * - Unimported by AppModule: 0% production reachability.
 * - Suppressed Schedulers: C.2 and C.3.3 schedulers are strictly disabled via explicit configuration.
 * - Single Worker Instances: Exactly one instance of C.2 and C.3.3 worker per module context.
 * - Restricted Observation: Command closure is granted only read-only `observe()` capability.
 * - Borrowed Worker Lifecycle: Coordinator borrows workers; NestJS container manages lifecycle.
 * - Zero Background Timers: Starts 0 interval timers regardless of external environment variables.
 */
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    // 1. Persistence & Invalidation Repositories
    {
      provide: ReservationFenceRepository,
      useFactory: (prisma: PrismaService) => new ReservationFenceRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: OrdinaryInvalidationRepository,
      useFactory: (prisma: PrismaService) => new OrdinaryInvalidationRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: OrdinaryReservationCommandRepository,
      useFactory: (prisma: PrismaService) => new OrdinaryReservationCommandRepository(prisma),
      inject: [PrismaService],
    },

    // 2. Invalidation Services
    {
      provide: OrdinaryInvalidationService,
      useFactory: (repo: OrdinaryInvalidationRepository, redis: RedisService) =>
        new OrdinaryInvalidationService(repo, redis),
      inject: [OrdinaryInvalidationRepository, RedisService],
    },
    {
      provide: OrdinaryInvalidationPublicationService,
      useFactory: (repo: OrdinaryInvalidationRepository) =>
        new OrdinaryInvalidationPublicationService(repo),
      inject: [OrdinaryInvalidationRepository],
    },
    OrdinaryRecoveryRegistryService,
    OrdinaryMarkerBootstrapService,
    OrdinaryInvalidationRecoveryService,

    // 3. C.2 Invalidation Worker (with suppressed scheduler)
    {
      provide: OrdinaryRecoverySweepWorker,
      useFactory: (
        repo: OrdinaryInvalidationRepository,
        recoveryService: OrdinaryInvalidationRecoveryService,
        bootstrapService: OrdinaryMarkerBootstrapService,
      ) =>
        new OrdinaryRecoverySweepWorker(
          repo,
          recoveryService,
          bootstrapService,
          { get: (key: string) => (key === 'ENABLE_SCHEDULER' ? 'false' : undefined) } as unknown as ConfigService,
        ),
      inject: [
        OrdinaryInvalidationRepository,
        OrdinaryInvalidationRecoveryService,
        OrdinaryMarkerBootstrapService,
      ],
    },

    // 4. Command Closure (restricted observation wrapper)
    {
      provide: OrdinaryCommandClosureService,
      useFactory: (prisma: PrismaService, redis: RedisService) => {
        const physical = new OrdinaryCommandPhysicalService(prisma, redis);
        return new OrdinaryCommandClosureService(prisma, {
          observe: (commandId: string) => physical.observe(commandId),
        });
      },
      inject: [PrismaService, RedisService],
    },

    // 5. C.3.1 Diagnostics
    OrdinaryRecoveryDiagnosticsService,

    // 6. C.3.2 Command Recovery Service
    {
      provide: OrdinaryCommandRecoveryService,
      useFactory: (
        commands: OrdinaryReservationCommandRepository,
        closure: OrdinaryCommandClosureService,
        diagnostics: OrdinaryRecoveryDiagnosticsService,
      ) => new OrdinaryCommandRecoveryService(commands, closure, diagnostics),
      inject: [
        OrdinaryReservationCommandRepository,
        OrdinaryCommandClosureService,
        OrdinaryRecoveryDiagnosticsService,
      ],
    },

    // 7. C.3.3 Command Sweep Worker (with scheduling disabled)
    {
      provide: OrdinaryCommandRecoverySweepWorker,
      useFactory: (recoveryService: OrdinaryCommandRecoveryService) =>
        new OrdinaryCommandRecoverySweepWorker(recoveryService, {
          enableScheduling: false,
        }),
      inject: [OrdinaryCommandRecoveryService],
    },

    // 8. C.3.4 Orchestration Coordinator
    {
      provide: OrdinaryRecoveryCoordinatorService,
      useFactory: (
        cmdWorker: OrdinaryCommandRecoverySweepWorker,
        invWorker: OrdinaryRecoverySweepWorker,
      ) => new OrdinaryRecoveryCoordinatorService(cmdWorker, invWorker),
      inject: [OrdinaryCommandRecoverySweepWorker, OrdinaryRecoverySweepWorker],
    },

    // 9. C.3.5 Telemetry Adapter
    {
      provide: OrdinaryRecoveryTelemetryAdapter,
      useFactory: (
        coordinator: OrdinaryRecoveryCoordinatorService,
        eventEmitter?: EventEmitter2,
      ) => new OrdinaryRecoveryTelemetryAdapter(coordinator, eventEmitter),
      inject: [OrdinaryRecoveryCoordinatorService, { token: EventEmitter2, optional: true }],
    },
  ],
  exports: [
    OrdinaryRecoveryTelemetryAdapter,
    OrdinaryRecoveryCoordinatorService,
  ],
})
export class OrdinaryRecoveryModule {}
