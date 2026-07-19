import { VendorComplianceStatusLabel, VendorTier } from '@iriefishmongers/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VendorSelectionCard } from './vendor-selection-card';

const baseProps = {
  vendorName: "Vera's Catch",
  tier: VendorTier.VERIFIED_VENDOR,
  badge: '✓ Verified Vendor',
  rating: null,
  deliveryEta: null,
  complianceStatus: VendorComplianceStatusLabel.COMPLIANT,
  price: 'JMD $850.00',
  onSelectVendor: jest.fn(),
  onViewProfile: jest.fn(),
};

describe('VendorSelectionCard', () => {
  it('renders vendor name, badge, and price', () => {
    render(<VendorSelectionCard {...baseProps} />);
    expect(screen.getByText("Vera's Catch")).toBeInTheDocument();
    expect(screen.getByText('✓ Verified Vendor')).toBeInTheDocument();
    expect(screen.getByText('JMD $850.00')).toBeInTheDocument();
  });

  it('shows an honest "not yet rated" / "not available" state instead of fabricating data', () => {
    render(<VendorSelectionCard {...baseProps} />);
    expect(screen.getByText('Not yet rated')).toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  it('formats a real rating and delivery ETA when provided', () => {
    render(<VendorSelectionCard {...baseProps} rating={4.5} deliveryEta="30-45 min" />);
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('30-45 min')).toBeInTheDocument();
  });

  it('calls onSelectVendor when Select Vendor is clicked', async () => {
    const onSelectVendor = jest.fn();
    render(<VendorSelectionCard {...baseProps} onSelectVendor={onSelectVendor} />);
    await userEvent.click(screen.getByRole('button', { name: 'Select Vendor' }));
    expect(onSelectVendor).toHaveBeenCalledTimes(1);
  });

  it('calls onViewProfile when View Profile is clicked', async () => {
    const onViewProfile = jest.fn();
    render(<VendorSelectionCard {...baseProps} onViewProfile={onViewProfile} />);
    await userEvent.click(screen.getByRole('button', { name: 'View Profile' }));
    expect(onViewProfile).toHaveBeenCalledTimes(1);
  });
});
