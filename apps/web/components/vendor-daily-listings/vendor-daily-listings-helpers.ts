import {
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  ProductUnit,
  VendorStatus,
  type DailyListingPhotoResponse,
  type DailyListingResponse,
  type RegulatoryEvaluationResult,
  type SeafoodLotAdmin,
  type VendorAdmin,
  type VendorComplianceStatus,
} from '@iriefishmongers/types';

export type WorkflowStep = 'draft' | 'photo' | 'review' | 'publish';

export const WORKFLOW_STEPS: ReadonlyArray<{ id: WorkflowStep; number: number; label: string }> = [
  { id: 'draft', number: 1, label: 'Draft' },
  { id: 'photo', number: 2, label: 'Photo' },
  { id: 'review', number: 3, label: 'Review' },
  { id: 'publish', number: 4, label: 'Publish' },
];

export const PRODUCT_UNIT_OPTIONS: ReadonlyArray<{ value: ProductUnit; label: string }> = [
  { value: ProductUnit.PER_POUND, label: 'Per pound (lb)' },
  { value: ProductUnit.PER_KILOGRAM, label: 'Per kilogram (kg)' },
  { value: ProductUnit.PER_PACKAGE, label: 'Per package' },
  { value: ProductUnit.PER_ITEM, label: 'Per item / whole fish' },
];

export const STATUS_BADGE_META: Record<
  string,
  { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  [ListingLifecycleStatus.DRAFT]: { label: 'Draft', variant: 'info' },
  [ListingLifecycleStatus.PUBLISHED]: { label: 'Published', variant: 'success' },
  [ListingLifecycleStatus.WITHDRAWN]: { label: 'Withdrawn', variant: 'neutral' },
  [ListingLifecycleStatus.SUSPENDED]: { label: 'Suspended', variant: 'danger' },
  EXPIRED: { label: 'Expired', variant: 'warning' },
  SOLD_OUT: { label: 'Sold Out', variant: 'warning' },
};

export function getStatusBadgeMeta(status: string): {
  label: string;
  variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  return STATUS_BADGE_META[status] ?? { label: status, variant: 'neutral' };
}

export function getLotEligibility(lot: SeafoodLotAdmin): {
  eligible: boolean;
  reason: string | null;
} {
  if (lot.foodSafetyStatus === FoodSafetyStatus.SAFE) {
    return { eligible: true, reason: null };
  }

  const notes = lot.statusNotes?.trim() ? ` (${lot.statusNotes.trim()})` : '';
  return {
    eligible: false,
    reason: `Food safety status is ${lot.foodSafetyStatus}; only SAFE lots may be listed${notes}.`,
  };
}

export function getVendorSellingBlockers(
  vendor: VendorAdmin | null | undefined,
  compliance: VendorComplianceStatus | null | undefined,
): string[] {
  const blockers: string[] = [];

  if (!vendor) {
    blockers.push('Your user account does not have a registered vendor business profile yet.');
    return blockers;
  }

  if (vendor.status !== VendorStatus.APPROVED) {
    blockers.push(
      `Vendor account status is ${vendor.status}; only APPROVED vendors may create and publish daily listings.`,
    );
  }

  if (compliance && !compliance.canSell) {
    const missingOrInvalid = compliance.requiredDocuments
      .filter((doc) => doc.status !== 'APPROVED')
      .map((doc) => `${doc.type} (${doc.status})`);
    blockers.push(
      missingOrInvalid.length > 0
        ? `Required compliance documents are not yet approved for your tier: ${missingOrInvalid.join(', ')}.`
        : 'Required compliance documents for your vendor tier are not approved.',
    );
  }

  return blockers;
}

export function getActiveListingPhotos(
  listing: Pick<DailyListingResponse, 'photos'> | null | undefined,
): DailyListingPhotoResponse[] {
  return (listing?.photos ?? []).filter((photo) => !photo.withdrawnAt);
}

export function getApprovedActivePhotos(
  listing: Pick<DailyListingResponse, 'photos'> | null | undefined,
): DailyListingPhotoResponse[] {
  return getActiveListingPhotos(listing).filter(
    (photo) => photo.moderationStatus === ListingPhotoModerationStatus.APPROVED,
  );
}

export function getDisplayPhoto(
  listing: Pick<DailyListingResponse, 'primaryPhoto' | 'photos'> | null | undefined,
): DailyListingPhotoResponse | null {
  if (listing?.primaryPhoto && !listing.primaryPhoto.withdrawnAt) {
    return listing.primaryPhoto;
  }
  const active = getActiveListingPhotos(listing);
  return active.find((photo) => photo.isPrimary) ?? active[0] ?? null;
}

export function validateCatchPhotoUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return 'Enter an actual-catch photograph URL before submitting.';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a valid URL starting with https:// (for example https://cdn.example.com/catch.jpg).';
  }

  if (parsed.protocol !== 'https:') {
    return 'Storefront catch images require an https:// URL (local file uploads and http:// URLs are not supported).';
  }

  return null;
}

export function getPublishBlockers(
  listing: DailyListingResponse,
  regulatoryEval: RegulatoryEvaluationResult | null | undefined,
  canVendorSell: boolean,
): string[] {
  const blockers: string[] = [];

  if (listing.status !== ListingLifecycleStatus.DRAFT) {
    blockers.push(`Only DRAFT listings can be published (current status: ${listing.status}).`);
  }

  if (new Date(listing.expiresAt).getTime() <= Date.now()) {
    blockers.push('Sale expiry time must be in the future before publishing.');
  }

  if (getApprovedActivePhotos(listing).length === 0) {
    blockers.push('Attach at least one approved actual-catch photograph before publishing.');
  }

  if (!canVendorSell) {
    blockers.push('Vendor approval and required tier compliance documents must be approved before selling.');
  }

  if (regulatoryEval && !regulatoryEval.eligible) {
    for (const reason of regulatoryEval.reasons) {
      blockers.push(reason);
    }
  }

  return blockers;
}

export function formatMoneyJmd(amount: number, currency = 'JMD'): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return `${currency} $${amount}`;
  }
  return `${currency} $${numeric.toLocaleString('en-JM', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDateTimeReadable(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('en-JM', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function toDateTimeLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromDateTimeLocalInput(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

export function getDefaultDraftDateInputs(lotCatchDateIso?: string): {
  catchDateLocal: string;
  expiresAtLocal: string;
} {
  const now = new Date();
  const catchSource = lotCatchDateIso ? new Date(lotCatchDateIso) : now;
  const clampedCatch =
    Number.isNaN(catchSource.getTime()) || catchSource.getTime() > now.getTime()
      ? now
      : catchSource;

  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const expiresTarget =
    tonight.getTime() - now.getTime() >= 2 * 60 * 60 * 1000
      ? tonight
      : new Date(now.getTime() + 8 * 60 * 60 * 1000);

  return {
    catchDateLocal: toDateTimeLocalInput(clampedCatch.toISOString()),
    expiresAtLocal: toDateTimeLocalInput(expiresTarget.toISOString()),
  };
}
