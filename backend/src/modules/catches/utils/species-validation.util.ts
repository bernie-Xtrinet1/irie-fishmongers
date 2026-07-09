import { BadRequestException } from '@nestjs/common';
import { Species } from '@prisma/client';

// Shared by CatchesService (registering a catch) and SeafoodLotsService
// (linking a species directly to a lot) so regulatory/seasonal rules are
// enforced identically regardless of entry point.
export function assertSpeciesSellable(species: Pick<Species, 'regulatoryStatus' | 'commercialName'>): void {
  if (species.regulatoryStatus === 'PROHIBITED') {
    throw new BadRequestException(`${species.commercialName} is currently prohibited from sale`);
  }
}

export function assertSpeciesInSeason(
  species: Pick<Species, 'seasonalStartMonth' | 'seasonalEndMonth' | 'commercialName'>,
  date: Date,
): void {
  if (species.seasonalStartMonth === null || species.seasonalEndMonth === null) {
    return;
  }
  const month = date.getUTCMonth() + 1;
  const { seasonalStartMonth, seasonalEndMonth } = species;
  const inSeason =
    seasonalStartMonth <= seasonalEndMonth
      ? month >= seasonalStartMonth && month <= seasonalEndMonth
      : month >= seasonalStartMonth || month <= seasonalEndMonth;

  if (!inSeason) {
    throw new BadRequestException(`${species.commercialName} is out of season for this date`);
  }
}
