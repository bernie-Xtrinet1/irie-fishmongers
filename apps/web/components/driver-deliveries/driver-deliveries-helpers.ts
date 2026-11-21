import {
  DriverAvailabilityStatus,
  DriverStatus,
  type DeliveryStage,
  type DriverDelivery,
  type DriverProfile,
} from '@iriefishmongers/types';

export const JAMAICA_TIME_ZONE = 'America/Jamaica';
export const JAMAICA_TZ_LABEL = 'Jamaica EST (UTC-5)';
const JAMAICA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

export function formatJamaicaDateTime(value: string | Date | null | undefined): string {
  if (!value) {
    return 'Not recorded';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const formatted = new Intl.DateTimeFormat('en-JM', {
    timeZone: JAMAICA_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return `${formatted} · ${JAMAICA_TZ_LABEL}`;
}

export function formatJamaicaWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start && !end) {
    return 'Not scheduled yet';
  }
  if (start && end) {
    const startText = formatJamaicaDateTime(start).replace(` · ${JAMAICA_TZ_LABEL}`, '');
    const endText = formatJamaicaDateTime(end).replace(` · ${JAMAICA_TZ_LABEL}`, '');
    return `${startText} – ${endText} · ${JAMAICA_TZ_LABEL}`;
  }
  return start ? `From ${formatJamaicaDateTime(start)}` : `Until ${formatJamaicaDateTime(end)}`;
}

/**
 * Formats an ISO instant as `YYYY-MM-DDTHH:mm` in Jamaica wall time (fixed UTC-5).
 */
export function toJamaicaDateTimeInput(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    return '';
  }
  const jmDate = new Date(ms - JAMAICA_UTC_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    jmDate.getUTCFullYear(),
    '-',
    pad(jmDate.getUTCMonth() + 1),
    '-',
    pad(jmDate.getUTCDate()),
    'T',
    pad(jmDate.getUTCHours()),
    ':',
    pad(jmDate.getUTCMinutes()),
  ].join('');
}

/**
 * Converts a `YYYY-MM-DDTHH:mm` value entered in Jamaica time (UTC-5) to a UTC ISO string.
 */
export function fromJamaicaDateTimeInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed}:00-05:00`
    : trimmed;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

export function isActiveDelivery(delivery: DriverDelivery): boolean {
  return delivery.stage === 'ASSIGNED' || delivery.stage === 'PICKED_UP';
}

export function sortDriverDeliveries(deliveries: DriverDelivery[]): {
  activeDeliveries: DriverDelivery[];
  pastDeliveries: DriverDelivery[];
} {
  const byAssignedDesc = (a: DriverDelivery, b: DriverDelivery): number =>
    new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime();

  const activeDeliveries = deliveries.filter(isActiveDelivery).sort(byAssignedDesc);
  const pastDeliveries = deliveries.filter((d) => !isActiveDelivery(d)).sort(byAssignedDesc);
  return { activeDeliveries, pastDeliveries };
}

export function getDeliveryStageBadge(stage: DeliveryStage): {
  label: string;
  variant: 'info' | 'warning' | 'success' | 'danger';
} {
  switch (stage) {
    case 'ASSIGNED':
      return { label: 'Assigned · Awaiting pickup', variant: 'info' };
    case 'PICKED_UP':
      return { label: 'Picked up · In transit', variant: 'warning' };
    case 'DELIVERED':
      return { label: 'Delivered', variant: 'success' };
    case 'FAILED':
      return { label: 'Delivery failed', variant: 'danger' };
  }
}

export interface DriverEligibilityBanner {
  badgeLabel: string;
  badgeVariant: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  title: string;
  description: string;
  canToggleAvailability: boolean;
  canBrowsePickups: boolean;
}

export function getDriverEligibilityBanner(
  profile: DriverProfile | null,
  profileMissing: boolean,
): DriverEligibilityBanner {
  if (profileMissing || !profile) {
    return {
      badgeLabel: 'Profile missing',
      badgeVariant: 'warning',
      title: 'Driver profile not registered yet',
      description:
        'Your account has the Driver role, but no vehicle and driver profile exists yet. Ask operations onboarding or register your vehicle details (POST /api/v1/drivers), then wait for administrator approval before going online.',
      canToggleAvailability: false,
      canBrowsePickups: false,
    };
  }

  if (profile.status === DriverStatus.PENDING) {
    return {
      badgeLabel: 'Pending approval',
      badgeVariant: 'warning',
      title: 'Awaiting administrator approval',
      description:
        'Your driver profile is under administrator review in the Admin Dashboard. You can review any past records below, and you will be able to go online once approved.',
      canToggleAvailability: false,
      canBrowsePickups: false,
    };
  }

  if (profile.status === DriverStatus.REJECTED) {
    return {
      badgeLabel: 'Application rejected',
      badgeVariant: 'danger',
      title: 'Driver profile not approved',
      description:
        'Your driver application was rejected. Contact marketplace operations to resolve onboarding requirements before claiming deliveries.',
      canToggleAvailability: false,
      canBrowsePickups: false,
    };
  }

  if (profile.status === DriverStatus.SUSPENDED) {
    return {
      badgeLabel: 'Suspended',
      badgeVariant: 'danger',
      title: 'Driver privileges suspended',
      description:
        'Your driver profile is currently suspended by an administrator. Going online and claiming pickups are disabled until reinstated.',
      canToggleAvailability: false,
      canBrowsePickups: false,
    };
  }

  if (profile.availabilityStatus === DriverAvailabilityStatus.BUSY) {
    return {
      badgeLabel: 'Busy · Active delivery',
      badgeVariant: 'info',
      title: 'Currently assigned to an active delivery',
      description:
        'Availability is locked to Busy while an active delivery is in progress. Complete or record failure on your active delivery before going offline or claiming another pickup.',
      canToggleAvailability: false,
      canBrowsePickups: false,
    };
  }

  if (profile.availabilityStatus === DriverAvailabilityStatus.ONLINE) {
    return {
      badgeLabel: 'Online',
      badgeVariant: 'success',
      title: 'Online and ready for pickups',
      description:
        'You can browse ready vendor orders below and claim one pickup job at a time.',
      canToggleAvailability: true,
      canBrowsePickups: true,
    };
  }

  return {
    badgeLabel: 'Offline',
    badgeVariant: 'neutral',
    title: 'Currently offline',
    description:
      'Go online when you are ready to browse ready vendor pickups and claim a delivery.',
    canToggleAvailability: true,
    canBrowsePickups: false,
  };
}

export function validateProofOfDeliveryUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 5) {
    throw new Error('Enter a valid hosted HTTPS proof URL (minimum 5 characters).');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Proof reference must be a valid https:// URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Proof URL must start with https:// so operations and customers can verify it securely.');
  }
  return trimmed;
}
