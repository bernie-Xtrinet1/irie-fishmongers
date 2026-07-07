import { VendorComplianceStatusLabel, VendorTier } from '@iriefishmongers/types';
import * as React from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

// Vendor Tier Badge component - .claude/ui/ui-screen-library.md "COMPONENT:
// Vendor Tier Badge" (Types: the 4 tiers; Display: Badge, Color, Tooltip,
// Compliance Status). `badge` is the label text sourced from the backend's
// VendorTierConfig.badge (e.g. "🐟 Community Fisher") - this component only
// owns color/tooltip/compliance-dot presentation, never the label text.
const TIER_STYLES: Record<VendorTier, string> = {
  [VendorTier.COMMUNITY_FISHER]: 'bg-ocean-blue/10 text-ocean-blue',
  [VendorTier.VERIFIED_VENDOR]: 'bg-irie-green/10 text-irie-green',
  [VendorTier.COMMERCIAL_SUPPLIER]: 'bg-irie-orange/10 text-irie-orange',
  [VendorTier.ENTERPRISE_SUPPLIER]: 'bg-gray-900 text-white',
};

const TIER_DESCRIPTIONS: Record<VendorTier, string> = {
  [VendorTier.COMMUNITY_FISHER]: 'Independent small-scale fisher or fish ground vendor.',
  [VendorTier.VERIFIED_VENDOR]: "Identity and business registration verified.",
  [VendorTier.COMMERCIAL_SUPPLIER]: 'Meets commercial food-safety and business compliance requirements.',
  [VendorTier.ENTERPRISE_SUPPLIER]: 'Full regulatory compliance for large-scale and export supply.',
};

const COMPLIANCE_DOT_STYLES: Record<VendorComplianceStatusLabel, string> = {
  [VendorComplianceStatusLabel.NOT_YET_ASSESSED]: 'bg-gray-400',
  [VendorComplianceStatusLabel.COMPLIANT]: 'bg-irie-green',
  [VendorComplianceStatusLabel.AT_RISK]: 'bg-irie-yellow',
  [VendorComplianceStatusLabel.NON_COMPLIANT]: 'bg-irie-red',
};

const COMPLIANCE_LABELS: Record<VendorComplianceStatusLabel, string> = {
  [VendorComplianceStatusLabel.NOT_YET_ASSESSED]: 'Not yet assessed',
  [VendorComplianceStatusLabel.COMPLIANT]: 'Compliant',
  [VendorComplianceStatusLabel.AT_RISK]: 'At risk',
  [VendorComplianceStatusLabel.NON_COMPLIANT]: 'Non-compliant',
};

export interface VendorTierBadgeProps {
  tier: VendorTier;
  badge: string;
  complianceStatus?: VendorComplianceStatusLabel;
  className?: string;
}

export function VendorTierBadge({
  tier,
  badge,
  complianceStatus,
  className,
}: VendorTierBadgeProps): React.ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
              TIER_STYLES[tier],
              className,
            )}
          >
            {badge}
            {complianceStatus ? (
              <span
                aria-hidden
                className={cn('h-1.5 w-1.5 rounded-full', COMPLIANCE_DOT_STYLES[complianceStatus])}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {TIER_DESCRIPTIONS[tier]}
          {complianceStatus ? ` Compliance: ${COMPLIANCE_LABELS[complianceStatus]}.` : ''}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
