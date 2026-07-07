import { VendorComplianceStatusLabel, VendorTier } from '@iriefishmongers/types';
import * as React from 'react';

import { VendorTierBadge } from './vendor-tier-badge';
import { cn } from './utils';

// Vendor Selection Card component - .claude/ui/ui-screen-library.md
// "COMPONENT: Vendor Selection Card" (Fields: Vendor Name, Tier Badge,
// Rating, Delivery ETA, Compliance Status, Price; Actions: Select Vendor,
// View Profile). Used on Mode 1 "Choose Vendor" listings and Mode 2's
// competing-vendor breakdown.
export interface VendorSelectionCardProps {
  vendorName: string;
  tier: VendorTier;
  badge: string;
  rating: number | null;
  deliveryEta: string | null;
  complianceStatus: VendorComplianceStatusLabel;
  price: string;
  onSelectVendor: () => void;
  onViewProfile: () => void;
  className?: string;
}

export function VendorSelectionCard({
  vendorName,
  tier,
  badge,
  rating,
  deliveryEta,
  complianceStatus,
  price,
  onSelectVendor,
  onViewProfile,
  className,
}: VendorSelectionCardProps): React.ReactElement {
  return (
    <div className={cn('rounded-card border border-gray-200 bg-white p-6 shadow-md', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-medium text-gray-900">{vendorName}</p>
          <div className="mt-1.5">
            <VendorTierBadge tier={tier} badge={badge} complianceStatus={complianceStatus} />
          </div>
        </div>
        <p className="text-lg font-semibold text-gray-900">{price}</p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm text-gray-600">
        <div>
          <dt className="text-xs text-gray-400">Rating</dt>
          <dd>{rating !== null ? rating.toFixed(1) : 'Not yet rated'}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-400">Delivery ETA</dt>
          <dd>{deliveryEta ?? 'Not available'}</dd>
        </div>
      </dl>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={onSelectVendor}
          className="flex-1 rounded-button bg-irie-green px-4 py-2 text-sm font-medium text-white hover:bg-irie-green/90"
        >
          Select Vendor
        </button>
        <button
          type="button"
          onClick={onViewProfile}
          className="flex-1 rounded-button border border-irie-green px-4 py-2 text-sm font-medium text-irie-green hover:bg-irie-green/10"
        >
          View Profile
        </button>
      </div>
    </div>
  );
}
