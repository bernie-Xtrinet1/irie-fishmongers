import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  RegulatoryStatus,
} from '@prisma/client';

import { SeafoodCatalogueRepository } from '../repositories/seafood-catalogue.repository';

export interface RegulatoryEvaluationContext {
  catalogueItemId: string;
  vendorDailyListingId?: string;
  seafoodLotId?: string;
  atDate?: Date;
}

export interface SpeciesEvaluationDetail {
  speciesId: string;
  commercialName: string;
  scientificName: string;
  regulatoryStatus: RegulatoryStatus;
  inSeason: boolean | null;
  prohibited: boolean;
}

export interface RegulatoryEvaluationResult {
  eligible: boolean;
  reasons: string[];
  evaluatedAt: Date;
  mode: 'ENFORCING' | 'DEGRADED_FAIL_CLOSED';
  details?: {
    compositionMode?: CatalogueCompositionMode;
    speciesEvaluated?: SpeciesEvaluationDetail[];
    overrideApplied?: boolean;
  };
}

@Injectable()
export class RegulatoryEligibilityService {
  private readonly logger = new Logger(RegulatoryEligibilityService.name);

  constructor(
    private readonly catalogueRepository: SeafoodCatalogueRepository,
    private readonly configService: ConfigService,
  ) {}

  getMode(): 'ENFORCING' | 'DEGRADED_FAIL_CLOSED' {
    const raw = this.configService.get<string>('REGULATORY_ENFORCEMENT_MODE', 'ENFORCING');
    return raw === 'DEGRADED_FAIL_CLOSED' ? 'DEGRADED_FAIL_CLOSED' : 'ENFORCING';
  }

  async evaluate(context: RegulatoryEvaluationContext): Promise<RegulatoryEvaluationResult> {
    const evaluatedAt = new Date();
    const mode = this.getMode();

    // 1. Safe-mode guard: In DEGRADED_FAIL_CLOSED, fail closed unconditionally.
    if (mode === 'DEGRADED_FAIL_CLOSED') {
      this.logger.warn(
        `Regulatory evaluation requested in DEGRADED_FAIL_CLOSED mode for catalogueItem=${context.catalogueItemId}`,
      );
      return {
        eligible: false,
        reasons: ['SERVICE_DEGRADED_FAIL_CLOSED'],
        evaluatedAt,
        mode,
      };
    }

    // 2. Fetch catalogue item with species relations and active overrides
    let item;
    try {
      item = await this.catalogueRepository.findById(context.catalogueItemId);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to query database for regulatory evaluation of catalogueItem=${context.catalogueItemId}: ${err}`,
      );
      return {
        eligible: false,
        reasons: ['REGULATORY_DATA_UNAVAILABLE'],
        evaluatedAt,
        mode,
      };
    }

    if (!item) {
      return {
        eligible: false,
        reasons: ['CATALOGUE_ITEM_NOT_FOUND'],
        evaluatedAt,
        mode,
      };
    }

    const reasons: string[] = [];
    const evalDate = context.atDate ? new Date(context.atDate) : evaluatedAt;
    const speciesDetails: SpeciesEvaluationDetail[] = [];

    // 3. Lifecycle Status check
    if (item.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
      reasons.push(
        `Catalogue item status is ${item.lifecycleStatus}; only PUBLISHED items are eligible for commercial listing`,
      );
    }

    // 4. Composition Mode structural validation
    switch (item.compositionMode) {
      case CatalogueCompositionMode.UNVERIFIED_COMPOSITION:
        reasons.push(
          'Catalogue item composition is UNVERIFIED_COMPOSITION; requires administrator review before commercial eligibility',
        );
        break;

      case CatalogueCompositionMode.SINGLE_SPECIES:
        if (item.speciesLinks.length !== 1) {
          reasons.push(
            `SINGLE_SPECIES composition requires exactly one linked species; found ${item.speciesLinks.length}`,
          );
        }
        break;

      case CatalogueCompositionMode.FIXED_COMPOSITE:
        if (item.speciesLinks.length < 2) {
          reasons.push(
            `FIXED_COMPOSITE composition requires at least two linked species; found ${item.speciesLinks.length}`,
          );
        }
        break;

      case CatalogueCompositionMode.VARIABLE_COMPOSITE:
        // Variable composite items may have typical species at the catalogue level,
        // but if no species link exists and no listing declaration is present, flag it.
        if (item.speciesLinks.length === 0 && !context.vendorDailyListingId) {
          reasons.push(
            'VARIABLE_COMPOSITE item requires species declaration at either catalogue or listing level',
          );
        }
        break;
    }

    // 5. Evaluate linked species for prohibitions, restrictions, and closed seasons
    let hasLegalProhibition = false;

    for (const link of item.speciesLinks) {
      const sp = link.species;
      const isProhibited = sp.regulatoryStatus === RegulatoryStatus.PROHIBITED;
      if (isProhibited) {
        hasLegalProhibition = true;
        reasons.push(
          `Species ${sp.commercialName} (${sp.scientificName}) is legally prohibited from commercial trade`,
        );
      }

      if (sp.regulatoryStatus === RegulatoryStatus.RESTRICTED) {
        reasons.push(
          `Species ${sp.commercialName} (${sp.scientificName}) is RESTRICTED and requires regulatory authority compliance verification`,
        );
      }

      // Check seasonal closed seasons using month boundaries
      let inSeason: boolean | null = null;
      if (sp.seasonalStartMonth !== null && sp.seasonalEndMonth !== null) {
        const month = evalDate.getUTCMonth() + 1; // 1 = January, 12 = December
        const start = sp.seasonalStartMonth;
        const end = sp.seasonalEndMonth;

        inSeason = start <= end
          ? month >= start && month <= end
          : month >= start || month <= end;

        if (inSeason === false) {
          reasons.push(
            `Species ${sp.commercialName} is currently out of season (closed season active for UTC month ${month})`,
          );
        }
      }

      speciesDetails.push({
        speciesId: sp.id,
        commercialName: sp.commercialName,
        scientificName: sp.scientificName,
        regulatoryStatus: sp.regulatoryStatus,
        inSeason,
        prohibited: isProhibited,
      });
    }

    // 6. Regulatory Override Evaluation
    // ADR-005 rules:
    // - A confirmed legal prohibition cannot be overridden under any circumstances.
    // - Only DATA_CORRECTION override is possible.
    // - Requester cannot be approver (two-party separation).
    // - Expired overrides fail closed.
    let overrideApplied = false;
    const activeOverride = await this.catalogueRepository.findActiveOverride(item.id, evalDate);

    if (activeOverride) {
      if (!activeOverride.approvedByUserId || activeOverride.requestedByUserId === activeOverride.approvedByUserId) {
        this.logger.error(
          `Invalid regulatory override on catalogueItem=${item.id}: override lacks valid two-party approval`,
        );
        reasons.push('Invalid regulatory override: two-party separation violated');
      } else if (hasLegalProhibition) {
        this.logger.warn(
          `Regulatory override rejected on catalogueItem=${item.id}: legal prohibitions cannot be bypassed`,
        );
        reasons.push('Legal prohibitions cannot be overridden under any circumstance');
      } else if (activeOverride.reason === 'DATA_CORRECTION') {
        // Legitimate data correction override suppresses non-prohibition warnings
        this.logger.log(
          `Applied active DATA_CORRECTION regulatory override ${activeOverride.id} on catalogueItem=${item.id}`,
        );
        overrideApplied = true;
      }
    }

    const eligible = overrideApplied ? !hasLegalProhibition : reasons.length === 0;

    return {
      eligible,
      reasons: overrideApplied && !hasLegalProhibition ? [] : reasons,
      evaluatedAt,
      mode,
      details: {
        compositionMode: item.compositionMode,
        speciesEvaluated: speciesDetails,
        overrideApplied,
      },
    };
  }
}
