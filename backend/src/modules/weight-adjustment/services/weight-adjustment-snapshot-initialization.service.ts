import { Injectable, Logger } from '@nestjs/common';
import {
  CustomerCheckoutCeilingConsent,
  PreparationChargeMethod,
  PreparationFeeStructure,
  Prisma,
  ProductUnit,
  SeafoodOrderWeightAdjustment,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { SeafoodPricingEngine } from '../domain/seafood-pricing-engine';
import { CeilingBelowEstimateError } from '../domain/seafood-pricing-engine.errors';
import { CustomerWeightConsentRepository } from '../repositories/customer-weight-consent.repository';
import {
  AmbiguousListingProvenanceError,
  ConflictingReplayError,
  InvalidPreparationOptionError,
  MissingAuthoritativeLotProvenanceError,
  MissingCheckoutConsentError,
  MissingListingProvenanceError,
  OrderItemNotFoundError,
  ProvenanceMismatchError,
  UnsupportedPreparationCurrencyError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../repositories/seafood-order-weight-adjustment.repository';
import { computeCanonicalPayloadHash } from '../repositories/utils/canonical-hash.util';
import {
  InitializeSnapshotInput,
  SnapshotInitializationResult,
} from './types/weight-adjustment-snapshot.types';
import { WeightAdjustmentSafetyGateService } from './weight-adjustment-safety-gate.service';

@Injectable()
export class WeightAdjustmentSnapshotInitializationService {
  private readonly logger = new Logger(WeightAdjustmentSnapshotInitializationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safetyGate: WeightAdjustmentSafetyGateService,
    private readonly adjustmentRepo: SeafoodOrderWeightAdjustmentRepository,
    private readonly consentRepo: CustomerWeightConsentRepository,
  ) {}

  /**
   * Validates material term consistency between incoming input, loaded order item, and existing snapshot.
   * Shared between normal idempotent replay and P2002 concurrency recovery.
   * Fails closed if checkout consent is missing or any material term conflicts.
   */
  private validateReplayConsistency(
    existing: SeafoodOrderWeightAdjustment & { checkoutCeilingConsent?: CustomerCheckoutCeilingConsent | null },
    input: InitializeSnapshotInput,
    orderItem: any,
  ): void {
    // 1. Mandatory checkout consent verification
    if (!existing.checkoutCeilingConsent) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Persisted weight adjustment for order item "${input.orderItemId}" lacks a CustomerCheckoutCeilingConsent record. Missing checkout consent prevents successful replay.`,
      );
    }

    const consent = existing.checkoutCeilingConsent;

    // 2. Consent payload hash verification
    const expectedHashPayload = {
      weightAdjustmentId: existing.id,
      authenticatedCustomerId: consent.authenticatedCustomerId,
      initialEstimatedWeight: new Decimal(consent.initialEstimatedWeight.toString()).toFixed(3),
      initialEstimatedTotal: new Decimal(consent.initialEstimatedTotal.toString()).toFixed(2),
      authorizedCeilingJmd: new Decimal(consent.authorizedCeilingJmd.toString()).toFixed(2),
      termsVersion: consent.termsVersion,
    };
    const computedHash = computeCanonicalPayloadHash(expectedHashPayload);
    if (computedHash !== consent.payloadHash) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Persisted CustomerCheckoutCeilingConsent payload hash is invalid or tampered on replay.`,
      );
    }

    // 3. Authenticated customer ID verification
    const expectedCustomerId = orderItem?.vendorOrder?.order?.customerId;
    if (expectedCustomerId && consent.authenticatedCustomerId !== expectedCustomerId) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Persisted consent authenticated customer "${consent.authenticatedCustomerId}" does not match order customer "${expectedCustomerId}".`,
      );
    }

    // 4. Authorized ceiling verification
    if (input.customerAuthorizedCeilingJmd !== undefined && input.customerAuthorizedCeilingJmd !== null) {
      const inputCeiling = new Decimal(input.customerAuthorizedCeilingJmd).toFixed(2);
      const existingCeiling = new Decimal(existing.customerAuthorizedCeilingJmd.toString()).toFixed(2);
      if (inputCeiling !== existingCeiling) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided ceiling JMD ${inputCeiling} conflicts with persisted ceiling JMD ${existingCeiling}.`,
        );
      }
    }

    // 5. Terms version verification
    if (input.termsVersion !== undefined && input.termsVersion !== null) {
      if (consent.termsVersion !== input.termsVersion) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided terms version "${input.termsVersion}" conflicts with persisted terms version "${consent.termsVersion}".`,
        );
      }
    }

    // 6. Pricing basis verification
    if (input.explicitPricingBasis !== undefined && input.explicitPricingBasis !== null) {
      if (existing.pricingBasis !== input.explicitPricingBasis) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided pricing basis "${input.explicitPricingBasis}" conflicts with persisted pricing basis "${existing.pricingBasis}".`,
        );
      }
    }

    // 7. Unit price verification
    if (orderItem?.unitPrice !== undefined && orderItem?.unitPrice !== null) {
      const orderItemUnitPrice = new Decimal(orderItem.unitPrice.toString()).toFixed(2);
      const existingUnitPrice = new Decimal(existing.unitPrice.toString()).toFixed(2);
      if (orderItemUnitPrice !== existingUnitPrice) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `OrderItem unit price ${orderItemUnitPrice} conflicts with persisted unit price ${existingUnitPrice}.`,
        );
      }
    }

    // 8. Unit verification
    if (orderItem?.unit !== undefined && orderItem?.unit !== null) {
      const expectedUnit =
        orderItem.unit === ProductUnit.PER_KILOGRAM ? WeightUnit.KILOGRAMS : WeightUnit.POUNDS;
      if (existing.unit !== expectedUnit) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Expected weight unit "${expectedUnit}" conflicts with persisted unit "${existing.unit}".`,
        );
      }
    }

    // 9. Estimated billable weight verification
    if (orderItem?.quantity !== undefined && orderItem?.quantity !== null) {
      const pieceCount = orderItem.quantity;
      const expectedEstimatedWeight = orderItem.product?.weightLbs
        ? new Decimal(orderItem.product.weightLbs.toString()).times(pieceCount)
        : new Decimal(pieceCount);
      if (!new Decimal(existing.estimatedBillableWeight.toString()).equals(expectedEstimatedWeight)) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Expected estimated weight ${expectedEstimatedWeight.toString()} conflicts with persisted estimated weight ${existing.estimatedBillableWeight.toString()}.`,
        );
      }
    }

    // 10. Preparation service selection verification
    const inputPrep = input.selectedPreparationServiceName?.trim() ?? null;
    const existingPrep = existing.preparationServiceName ?? null;
    if (inputPrep !== existingPrep) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Provided preparation service "${inputPrep}" conflicts with persisted preparation service "${existingPrep}".`,
      );
    }

    // 11. Usable parts preference verification
    const inputUsable = input.usablePartsPreference ?? UsablePartsPreference.RETURN_USABLE_PARTS;
    if (existing.usablePartsPreference !== inputUsable) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Provided usable parts preference "${inputUsable}" conflicts with persisted preference "${existing.usablePartsPreference}".`,
      );
    }

    // 12. Persisted provenance verification (if available on orderItem)
    const persistedLotId = (orderItem as any)?.originalLotId ?? (orderItem as any)?.lotId;
    const persistedListingId = (orderItem as any)?.originalListingId ?? (orderItem as any)?.listingId;
    if (persistedListingId && input.authoritativeListingId && input.authoritativeListingId !== persistedListingId) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Provided listing ID "${input.authoritativeListingId}" conflicts with persisted order listing "${persistedListingId}".`,
      );
    }
    if (persistedLotId && input.verifiedOrderTimeEvidence && input.verifiedOrderTimeEvidence.lotId !== persistedLotId) {
      throw new ConflictingReplayError(
        input.orderItemId,
        `Provided lot ID "${input.verifiedOrderTimeEvidence.lotId}" conflicts with persisted order lot "${persistedLotId}".`,
      );
    }

    // 13. V2 preparation charge method verification
    if (input.preparationChargeMethod !== undefined && input.preparationChargeMethod !== null) {
      if (existing.preparationChargeMethod !== input.preparationChargeMethod) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided preparationChargeMethod "${input.preparationChargeMethod}" conflicts with persisted method "${existing.preparationChargeMethod}".`,
        );
      }
    }

    // 14. V2 fish count verification
    if (input.fishCount !== undefined && input.fishCount !== null) {
      if (existing.fishCount !== input.fishCount) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided fishCount ${input.fishCount} conflicts with persisted fishCount ${existing.fishCount}.`,
        );
      }
    }

    // 15. V2 original whole weight verification
    if (input.originalWholeWeightLbs !== undefined && input.originalWholeWeightLbs !== null) {
      const inputWeight = new Decimal(input.originalWholeWeightLbs.toString());
      if (
        !existing.originalWholeWeightLbs ||
        !new Decimal(existing.originalWholeWeightLbs.toString()).equals(inputWeight)
      ) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided originalWholeWeightLbs ${inputWeight.toString()} conflicts with persisted weight ${String(existing.originalWholeWeightLbs)}.`,
        );
      }
    }

    // 16. V2 quote ID verification
    if (input.quoteId !== undefined && input.quoteId !== null) {
      if (consent.quoteId !== input.quoteId) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided quoteId "${input.quoteId}" conflicts with persisted quoteId "${consent.quoteId}".`,
        );
      }
    }

    // 17. V2 quote payload hash verification
    if (input.quotePayloadHash !== undefined && input.quotePayloadHash !== null) {
      if (consent.quotePayloadHash !== input.quotePayloadHash.toLowerCase()) {
        throw new ConflictingReplayError(
          input.orderItemId,
          `Provided quotePayloadHash "${input.quotePayloadHash}" conflicts with persisted quotePayloadHash "${consent.quotePayloadHash}".`,
        );
      }
    }
  }

  /**
   * Initializes a durable, revision-bound seafood weight adjustment snapshot and customer consent record.
   * - Enforces fail-closed multi-record food-safety gate.
   * - Requires authoritative, persisted immutable order-time lot and listing provenance.
   * - Unauthenticated caller-supplied evidence or inferences from mutable product records are strictly rejected.
   * - Isolates legacy products (returns SKIPPED_LEGACY_PRODUCT).
   * - Strictly preserves explicit customer-authorized ceiling (no synthesized 15% tolerance).
   * - Executes atomically in a Prisma interactive transaction.
   * - Safely idempotent on replay with comprehensive material term validation.
   */
  async initializeSnapshot(
    input: InitializeSnapshotInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SnapshotInitializationResult> {
    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      // 1. Resolve authoritative OrderItem with complete graph
      const orderItem = await txClient.orderItem.findUnique({
        where: { id: input.orderItemId },
        include: {
          vendorOrder: {
            include: {
              order: true,
              vendor: true,
            },
          },
          product: {
            include: {
              lot: true,
              catalogueItem: true,
            },
          },
          weightAdjustment: {
            include: {
              checkoutCeilingConsent: true,
            },
          },
        },
      });

      if (!orderItem) {
        throw new OrderItemNotFoundError(input.orderItemId);
      }

      // 2. Idempotent replay check on existing projection using shared material term validator
      if (orderItem.weightAdjustment) {
        this.validateReplayConsistency(orderItem.weightAdjustment, input, orderItem);
        return {
          status: 'IDEMPOTENT_REPLAY' as const,
          weightAdjustment: orderItem.weightAdjustment,
          checkoutConsent: orderItem.weightAdjustment.checkoutCeilingConsent ?? undefined,
        };
      }

      // 3. Legacy product isolation
      const isLegacyProduct =
        orderItem.product.inventoryMode === 'LEGACY_PRODUCT' && orderItem.product.lotId === null;

      if (isLegacyProduct) {
        return {
          status: 'SKIPPED_LEGACY_PRODUCT' as const,
          reason: 'Order item is a standard legacy product without catch-weight adjustment requirement.',
        };
      }

      // 4. Resolve authoritative original-lot and listing identity from immutable persisted DB record
      // Caller-supplied input.verifiedOrderTimeEvidence is unauthenticated and MUST NOT be accepted
      // as proof of purchase without authoritative persisted DB evidence.
      const persistedLotId = ((orderItem as any).originalLotId ?? (orderItem as any).lotId) as string | undefined;
      const persistedListingId = ((orderItem as any).originalListingId ?? (orderItem as any).listingId) as string | undefined;

      if (!persistedLotId || !persistedListingId) {
        throw new MissingAuthoritativeLotProvenanceError(
          orderItem.id,
          `OrderItem "${orderItem.id}" lacks authoritative, immutable persisted order-time lot and listing evidence in database. Accepting unauthenticated caller-supplied evidence or inferring provenance from mutable product records is strictly prohibited.`,
        );
      }

      // If caller provided evidence or listing ID, ensure it does not conflict with persisted truth
      if (input.verifiedOrderTimeEvidence) {
        if (
          input.verifiedOrderTimeEvidence.lotId !== persistedLotId ||
          input.verifiedOrderTimeEvidence.listingId !== persistedListingId
        ) {
          throw new ProvenanceMismatchError(
            `Caller-supplied evidence does not match persisted order-time provenance (persisted lot: "${persistedLotId}", listing: "${persistedListingId}").`,
          );
        }
      }

      if (input.authoritativeListingId && input.authoritativeListingId !== persistedListingId) {
        throw new ProvenanceMismatchError(
          `Caller-supplied listing "${input.authoritativeListingId}" differs from verified persisted listing "${persistedListingId}".`,
        );
      }

      const originalLotId = persistedLotId;
      const authoritativeListingId = persistedListingId;

      // 5. Fetch and verify the authoritative listing
      const listing = await txClient.vendorDailyListing.findUnique({
        where: { id: authoritativeListingId },
        select: {
          id: true,
          lotId: true,
          vendorId: true,
          productId: true,
          unit: true,
          price: true,
          preparationOptions: true,
          expiresAt: true,
          createdAt: true,
        },
      });

      if (!listing) {
        throw new MissingListingProvenanceError(
          orderItem.productId,
          `Authoritative listing "${authoritativeListingId}" was not found.`,
        );
      }

      // Consistency check: Listing lot must match verified original order lot
      if (listing.lotId !== originalLotId) {
        throw new ProvenanceMismatchError(
          'Listing seafood lot differs from the original order lot.',
        );
      }

      // Consistency check: Listing product and vendor must match order item
      if (
        listing.productId !== orderItem.productId ||
        listing.vendorId !== orderItem.vendorOrder.vendorId
      ) {
        throw new ProvenanceMismatchError(
          `Authoritative listing "${authoritativeListingId}" does not match order item product or vendor.`,
        );
      }

      // Consistency check: A listing created after checkout cannot establish original-lot provenance
      if (
        new Date(listing.createdAt).getTime() >
        new Date(orderItem.createdAt).getTime() + 60_000
      ) {
        throw new ProvenanceMismatchError(
          'A listing created after checkout cannot establish original-lot provenance.',
        );
      }

      // Consistency check: Current product lot must not conflict with original order provenance
      if (
        orderItem.product.lotId !== null &&
        orderItem.product.lotId !== originalLotId
      ) {
        throw new ProvenanceMismatchError(
          'Current product lot conflicts with original order provenance.',
        );
      }

      // 6. Authoritative Food-Safety Gate Evaluation on Original Lot
      await this.safetyGate.assertLotSafeForFulfillment(
        {
          seafoodLotId: originalLotId,
          vendorId: orderItem.vendorOrder.vendorId,
          vendorDailyListingId: listing.id,
          atDate: orderItem.createdAt,
        },
        txClient,
      );

      // 7. Validate Customer Checkout Ceiling and Consent
      // Prohibit synthesizing 15% tolerance: explicit customer consent is mandatory
      if (
        input.customerAuthorizedCeilingJmd === undefined ||
        input.customerAuthorizedCeilingJmd === null ||
        new Decimal(input.customerAuthorizedCeilingJmd).lessThanOrEqualTo(0)
      ) {
        throw new MissingCheckoutConsentError(
          'Customer authorized ceiling JMD is required to initialize snapshot. Synthesizing tolerance is prohibited.',
        );
      }

      if (!input.termsVersion || input.termsVersion.trim() === '') {
        throw new MissingCheckoutConsentError(
          'Checkout terms version is required to record customer consent.',
        );
      }

      const authorizedCeiling = new Decimal(input.customerAuthorizedCeilingJmd);

      // 8. Determine pricing basis and weight units
      const pricingBasis: SeafoodPricingBasis =
        input.explicitPricingBasis ?? SeafoodPricingBasis.WHOLE_RAW;

      const unit: WeightUnit =
        orderItem.unit === ProductUnit.PER_KILOGRAM ? WeightUnit.KILOGRAMS : WeightUnit.POUNDS;

      const unitPrice = new Decimal(orderItem.unitPrice.toString());
      const pieceCount = orderItem.quantity;

      // Estimated billable weight
      const estimatedWeight = orderItem.product.weightLbs
        ? new Decimal(orderItem.product.weightLbs.toString()).times(pieceCount)
        : new Decimal(pieceCount);

      // 9. Preparation fee calculation strictly against PreparationOptionDto[] contract
      let preparationFeeStructure: PreparationFeeStructure = PreparationFeeStructure.FLAT_FEE;
      let preparationFeeRate = new Decimal(0);
      let estimatedPreparationFee: Decimal;
      let estimatedProductSubtotal: Decimal;
      let estimatedItemTotal: Decimal;

      if (input.preparationChargeMethod !== undefined && input.preparationChargeMethod !== null) {
        // V2 preparation calculation and validation path
        if (!Object.values(PreparationChargeMethod).includes(input.preparationChargeMethod)) {
          throw new InvalidPreparationOptionError(
            String(input.preparationChargeMethod),
            `Unrecognized preparationChargeMethod "${input.preparationChargeMethod}".`,
          );
        }

        if (input.preparationChargeMethod === PreparationChargeMethod.NO_PREPARATION) {
          // Preserve NO_PREPARATION as a zero-charge method
          preparationFeeRate = new Decimal(0);
          estimatedPreparationFee = new Decimal('0.00');

          if (input.selectedPreparationServiceName) {
            const selectedName = input.selectedPreparationServiceName.trim();
            const prepOptions = listing.preparationOptions;
            if (!Array.isArray(prepOptions)) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `Listing does not have a valid preparation options array for selected service "${selectedName}".`,
              );
            }
            const selectedLower = selectedName.toLowerCase();
            const matchedOption = prepOptions.find(
              (opt: any) =>
                opt &&
                typeof opt === 'object' &&
                ((typeof opt.id === 'string' && opt.id.trim().toLowerCase() === selectedLower) ||
                  (typeof opt.label === 'string' && opt.label.trim().toLowerCase() === selectedLower)),
            );
            if (!matchedOption) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `Selected preparation service "${selectedName}" is not offered on authoritative listing "${listing.id}".`,
              );
            }
            const option = matchedOption as Record<string, any>;
            if (option.chargeMethod && option.chargeMethod !== PreparationChargeMethod.NO_PREPARATION) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `Requested preparation method "NO_PREPARATION" conflicts with configured option method "${option.chargeMethod}".`,
              );
            }
            if (option.rate !== undefined && option.rate !== null) {
              const rateDec = new Decimal(option.rate.toString());
              if (!rateDec.isZero()) {
                throw new InvalidPreparationOptionError(
                  selectedName,
                  `NO_PREPARATION option requires zero rate (got: ${option.rate}).`,
                );
              }
            }
          }
        } else {
          // Chargeable V2 method: FIXED_PER_FISH or FIXED_PER_POUND
          if (!input.selectedPreparationServiceName || input.selectedPreparationServiceName.trim() === '') {
            throw new InvalidPreparationOptionError(
              String(input.preparationChargeMethod),
              `Selected preparation service name is required for chargeable method "${input.preparationChargeMethod}".`,
            );
          }

          const selectedName = input.selectedPreparationServiceName.trim();
          const prepOptions = listing.preparationOptions;

          if (!Array.isArray(prepOptions)) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Listing does not have a valid preparation options array for selected service "${selectedName}".`,
            );
          }

          const selectedLower = selectedName.toLowerCase();
          const matchedOption = prepOptions.find(
            (opt: any) =>
              opt &&
              typeof opt === 'object' &&
              ((typeof opt.id === 'string' && opt.id.trim().toLowerCase() === selectedLower) ||
                (typeof opt.label === 'string' && opt.label.trim().toLowerCase() === selectedLower)),
          );

          if (!matchedOption) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Selected preparation service "${selectedName}" is not offered on authoritative listing "${listing.id}".`,
            );
          }

          const option = matchedOption as Record<string, any>;

          // 1. Verify requested method matches authoritative listing option's configured method
          if (!option.chargeMethod || option.chargeMethod !== input.preparationChargeMethod) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Requested preparation method "${input.preparationChargeMethod}" does not match configured option method "${option.chargeMethod ?? 'undefined'}".`,
            );
          }

          // 2. Do not interpret legacy fee as a V2 per-pound or per-fish rate
          if (option.rate === undefined || option.rate === null || typeof option.rate !== 'string' || option.rate.trim() === '') {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Preparation option "${selectedName}" is missing mandatory V2 rate string. Interpreting legacy fee as a V2 rate is strictly prohibited.`,
            );
          }

          preparationFeeRate = new Decimal(option.rate.toString());
          if (!preparationFeeRate.isFinite() || preparationFeeRate.lte(0)) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Preparation option "${selectedName}" rate must be a positive finite value (got: "${option.rate}").`,
            );
          }

          // 3. Enforce required fish count and whole-weight inputs & reject invalid combinations
          if (input.preparationChargeMethod === PreparationChargeMethod.FIXED_PER_FISH) {
            if (
              input.fishCount === undefined ||
              input.fishCount === null ||
              typeof input.fishCount !== 'number' ||
              !Number.isInteger(input.fishCount) ||
              input.fishCount <= 0
            ) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `FIXED_PER_FISH requires positive integer fishCount (got: ${String(input.fishCount)}).`,
              );
            }
            estimatedPreparationFee = new Decimal(input.fishCount)
              .times(preparationFeeRate)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          } else {
            // FIXED_PER_POUND
            if (input.originalWholeWeightLbs === undefined || input.originalWholeWeightLbs === null) {
              throw new InvalidPreparationOptionError(
                selectedName,
                'FIXED_PER_POUND requires originalWholeWeightLbs.',
              );
            }
            let wholeWeightDec: Decimal;
            try {
              wholeWeightDec = new Decimal(input.originalWholeWeightLbs.toString());
            } catch {
              throw new InvalidPreparationOptionError(
                selectedName,
                `originalWholeWeightLbs could not be parsed as Decimal (got: "${String(input.originalWholeWeightLbs)}").`,
              );
            }
            if (!wholeWeightDec.isFinite() || wholeWeightDec.lte(0)) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `FIXED_PER_POUND requires positive finite originalWholeWeightLbs (got: ${wholeWeightDec.toString()}).`,
              );
            }
            if (wholeWeightDec.decimalPlaces() > 8) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `originalWholeWeightLbs "${wholeWeightDec.toString()}" cannot exceed 8 decimal places for exact lossless DECIMAL(16,8) representability.`,
              );
            }
            if (wholeWeightDec.gte(new Decimal('100000000'))) {
              throw new InvalidPreparationOptionError(
                selectedName,
                `originalWholeWeightLbs exceeds maximum capacity (< 10^8): "${wholeWeightDec.toString()}".`,
              );
            }
            estimatedPreparationFee = wholeWeightDec
              .times(preparationFeeRate)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          }
        }

        estimatedProductSubtotal = estimatedWeight.times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        estimatedItemTotal = estimatedProductSubtotal.plus(estimatedPreparationFee);

        if (authorizedCeiling.lessThan(estimatedItemTotal)) {
          throw new MissingCheckoutConsentError(
            `Authorized ceiling JMD ${authorizedCeiling.toFixed(2)} cannot be lower than initial estimated total JMD ${estimatedItemTotal.toFixed(2)}.`,
          );
        }
      } else {
        // V1 legacy calculation path via SeafoodPricingEngine
        if (input.selectedPreparationServiceName) {
          const selectedName = input.selectedPreparationServiceName.trim();
          const prepOptions = listing.preparationOptions;

          if (!Array.isArray(prepOptions)) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Listing does not have a valid preparation options array for selected service "${selectedName}".`,
            );
          }

          const selectedLower = selectedName.toLowerCase();
          const matchedOption = prepOptions.find(
            (opt: any) =>
              opt &&
              typeof opt === 'object' &&
              ((typeof opt.id === 'string' && opt.id.trim().toLowerCase() === selectedLower) ||
                (typeof opt.label === 'string' && opt.label.trim().toLowerCase() === selectedLower)),
          );

          if (!matchedOption) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Selected preparation service "${selectedName}" is not offered on authoritative listing "${listing.id}".`,
            );
          }

          const option = matchedOption as Record<string, any>;

          // Validate that fee is present, numeric, finite and nonnegative
          if (
            option.fee === undefined ||
            option.fee === null ||
            typeof option.fee !== 'number' ||
            isNaN(option.fee) ||
            !isFinite(option.fee) ||
            option.fee < 0
          ) {
            throw new InvalidPreparationOptionError(
              selectedName,
              `Preparation option "${selectedName}" has an invalid, negative, or missing fee: ${option.fee}.`,
            );
          }

          // Validate currency (must be JMD)
          if (option.currency !== undefined && option.currency !== null) {
            if (
              typeof option.currency !== 'string' ||
              option.currency.trim().toUpperCase() !== 'JMD'
            ) {
              throw new UnsupportedPreparationCurrencyError(
                String(option.currency),
                `Preparation fee currency "${option.currency}" is unsupported for service "${selectedName}". Only JMD is permitted.`,
              );
            }
          }

          preparationFeeStructure = PreparationFeeStructure.FLAT_FEE;
          preparationFeeRate = new Decimal(option.fee.toString());
        } else {
          // Absent preparation selection: zero preparation fee
          preparationFeeStructure = PreparationFeeStructure.FLAT_FEE;
          preparationFeeRate = new Decimal(0);
        }

        let pricingResult;
        try {
          pricingResult = SeafoodPricingEngine.calculate({
            pricingBasis: pricingBasis as any,
            unit: unit === WeightUnit.KILOGRAMS ? 'PER_KILOGRAM' : 'PER_POUND',
            unitPrice,
            estimatedWeight,
            customerAuthorizedCeilingJmd: authorizedCeiling,
            preparation: {
              feeStructure: preparationFeeStructure as any,
              feeRate: preparationFeeRate,
            },
          });
        } catch (err) {
          if (err instanceof CeilingBelowEstimateError) {
            throw new MissingCheckoutConsentError(
              `Authorized ceiling JMD ${authorizedCeiling.toFixed(2)} cannot be lower than initial estimated total.`,
            );
          }
          throw err;
        }

        estimatedPreparationFee = pricingResult.estimatedPreparationFee;
        estimatedProductSubtotal = pricingResult.estimatedProductSubtotal;
        estimatedItemTotal = pricingResult.estimatedItemTotal;
      }

      // 10. Persist SeafoodOrderWeightAdjustment Snapshot
      const snapshot = await this.adjustmentRepo.createAdjustmentSnapshot(
        {
          orderItemId: orderItem.id,
          pricingBasis,
          unit,
          unitPrice,
          pieceCount,
          estimatedBillableWeight: estimatedWeight,
          preparationServiceName: input.selectedPreparationServiceName ?? undefined,
          usablePartsPreference:
            input.usablePartsPreference ?? UsablePartsPreference.RETURN_USABLE_PARTS,
          preparationFeeStructure,
          preparationFeeRate,
          estimatedPreparationFee,
          estimatedProductSubtotal,
          estimatedItemTotal,
          customerAuthorizedCeilingJmd: authorizedCeiling,
          preparationChargeMethod: input.preparationChargeMethod,
          fishCount: input.fishCount,
          originalWholeWeightLbs:
            input.originalWholeWeightLbs !== undefined && input.originalWholeWeightLbs !== null
              ? new Decimal(input.originalWholeWeightLbs.toString())
              : undefined,
          originalWholeWeightUnit: input.originalWholeWeightUnit,
        },
        txClient,
      );

      // 11. Persist CustomerCheckoutCeilingConsent Record
      const consent = await this.consentRepo.recordCheckoutCeilingConsent(
        {
          weightAdjustmentId: snapshot.id,
          authenticatedCustomerId: orderItem.vendorOrder.order.customerId,
          initialEstimatedWeight: estimatedWeight,
          initialEstimatedTotal: estimatedItemTotal,
          authorizedCeilingJmd: authorizedCeiling,
          termsVersion: input.termsVersion,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          quoteId: input.quoteId,
          quotePayloadHash: input.quotePayloadHash,
        },
        txClient,
      );

      return {
        status: 'INITIALIZED' as const,
        weightAdjustment: snapshot,
        checkoutConsent: consent,
      };
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      }
      return await this.prisma.$transaction(executeInTransaction);
    } catch (err) {
      if (!tx && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Concurrency recovery outside the failed transaction using fresh un-aborted client
        const recovered = await this.prisma.seafoodOrderWeightAdjustment.findUnique({
          where: { orderItemId: input.orderItemId },
          include: { checkoutCeilingConsent: true },
        });
        if (recovered) {
          // Re-fetch order item to run full consistency check
          const orderItem = await this.prisma.orderItem.findUnique({
            where: { id: input.orderItemId },
            include: {
              vendorOrder: { include: { order: true, vendor: true } },
              product: { include: { lot: true, catalogueItem: true } },
            },
          });
          if (orderItem) {
            this.validateReplayConsistency(recovered, input, orderItem);
            return {
              status: 'IDEMPOTENT_REPLAY' as const,
              weightAdjustment: recovered,
              checkoutConsent: recovered.checkoutCeilingConsent ?? undefined,
            };
          }
        }
      }
      throw err;
    }
  }
}
