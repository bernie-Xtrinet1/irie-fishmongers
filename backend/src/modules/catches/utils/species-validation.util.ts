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

// null = no seasonal restriction configured for this species; a
// restriction and an out-of-season catch are different facts and must
// not collapse to the same falsy value (the passport's sustainability
// block depends on this distinction).
export function isSpeciesInSeason(
  species: Pick<Species, 'seasonalStartMonth' | 'seasonalEndMonth'>,
  date: Date,
): boolean | null {
  if (species.seasonalStartMonth === null || species.seasonalEndMonth === null) {
    return null;
  }
  const month = date.getUTCMonth() + 1;
  const { seasonalStartMonth, seasonalEndMonth } = species;
  return seasonalStartMonth <= seasonalEndMonth
    ? month >= seasonalStartMonth && month <= seasonalEndMonth
    : month >= seasonalStartMonth || month <= seasonalEndMonth;
}

export function assertSpeciesInSeason(
  species: Pick<Species, 'seasonalStartMonth' | 'seasonalEndMonth' | 'commercialName'>,
  date: Date,
): void {
  if (isSpeciesInSeason(species, date) === false) {
    throw new BadRequestException(`${species.commercialName} is out of season for this date`);
  }
}
