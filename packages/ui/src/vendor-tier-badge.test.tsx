import { VendorComplianceStatusLabel, VendorTier } from '@iriefishmongers/types';
import { render, screen } from '@testing-library/react';

import { VendorTierBadge } from './vendor-tier-badge';

describe('VendorTierBadge', () => {
  it('renders the badge label passed in from the backend', () => {
    render(<VendorTierBadge tier={VendorTier.COMMUNITY_FISHER} badge="🐟 Community Fisher" />);
    expect(screen.getByText('🐟 Community Fisher')).toBeInTheDocument();
  });

  it.each([
    [VendorTier.COMMUNITY_FISHER, 'bg-ocean-blue/10'],
    [VendorTier.VERIFIED_VENDOR, 'bg-irie-green/10'],
    [VendorTier.COMMERCIAL_SUPPLIER, 'bg-irie-orange/10'],
    [VendorTier.ENTERPRISE_SUPPLIER, 'bg-gray-900'],
  ])('applies the %s tier color', (tier, expectedClass) => {
    render(<VendorTierBadge tier={tier} badge="Badge" />);
    expect(screen.getByText('Badge')).toHaveClass(expectedClass);
  });

  it('renders no compliance dot when compliance status is not provided', () => {
    const { container } = render(
      <VendorTierBadge tier={VendorTier.VERIFIED_VENDOR} badge="✓ Verified Vendor" />,
    );
    expect(container.querySelector('[aria-hidden]')).not.toBeInTheDocument();
  });

  it('renders a compliance dot when compliance status is provided', () => {
    const { container } = render(
      <VendorTierBadge
        tier={VendorTier.VERIFIED_VENDOR}
        badge="✓ Verified Vendor"
        complianceStatus={VendorComplianceStatusLabel.COMPLIANT}
      />,
    );
    expect(container.querySelector('[aria-hidden]')).toHaveClass('bg-irie-green');
  });
});
