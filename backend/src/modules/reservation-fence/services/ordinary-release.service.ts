import { OrdinaryReservationCommand, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryInvalidationPublicationService } from './ordinary-invalidation-publication.service';
import { OrdinaryReleaseAdmission, PublicationReleaseInput } from '../types/ordinary-release.types';

// Inactive: no decorator, module, worker, production caller or Redis dependency.
export class OrdinaryReleaseService {
  readonly #admissions = new WeakMap<object, OrdinaryReservationCommand>();
  private readonly publication: OrdinaryInvalidationPublicationService;
  private readonly commands: OrdinaryReservationCommandRepository;
  constructor(prisma: PrismaService) {
    this.publication = new OrdinaryInvalidationPublicationService(new OrdinaryInvalidationRepository(prisma));
    this.commands = new OrdinaryReservationCommandRepository(prisma);
  }

  async publish(intentId: string, input: PublicationReleaseInput,
    domain: (tx: Prisma.TransactionClient) => Promise<Prisma.InputJsonValue>): Promise<{
      status: 'PUBLISHED'; command: OrdinaryReservationCommand; admission: OrdinaryReleaseAdmission;
    } | { status: 'UNRESOLVED' }> {
    const snapshot = { ...input };
    let inserted: OrdinaryReservationCommand | undefined;
    try {
      await this.publication.publishNew(intentId, async tx => {
        const result = await domain(tx);
        inserted = await this.commands.insertPublicationRelease(tx, intentId, snapshot);
        return { domain: result, releaseCommandId: inserted.id };
      });
      if (!inserted) return { status: 'UNRESOLVED' };
      const admission = Object.freeze({}) as OrdinaryReleaseAdmission;
      this.#admissions.set(admission, structuredClone(inserted));
      return { status: 'PUBLISHED', command: inserted, admission };
    } catch { return { status: 'UNRESOLVED' }; }
  }

  // The private field enforces genuine instance provenance even for prototype fakes.
  consumeAdmission(value: unknown): OrdinaryReservationCommand | null {
    if (!value || typeof value !== 'object') return null;
    const command = this.#admissions.get(value);
    if (!command) return null;
    this.#admissions.delete(value);
    return structuredClone(command);
  }
}
