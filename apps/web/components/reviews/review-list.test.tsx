import type { ReviewSummary } from '@iriefishmongers/types';
import { render, screen } from '@testing-library/react';

import { ReviewList } from './review-list';

const review: ReviewSummary = {
  id: 'review-1',
  authorDisplayName: 'Bernard W.',
  verifiedPurchase: true,
  rating: 5,
  title: 'Very fresh',
  body: 'Delivered cold and on time.',
  productId: 'product-1',
  productName: 'Fresh Snapper',
  createdAt: new Date('2026-07-10').toISOString(),
  editedAt: null,
};

describe('ReviewList', () => {
  it('renders the masked name, verified badge, rating, and body', () => {
    render(<ReviewList reviews={[review]} />);

    expect(screen.getByText('Bernard W.')).toBeInTheDocument();
    expect(screen.getByText('Verified Buyer')).toBeInTheDocument();
    expect(screen.getByText('Very fresh')).toBeInTheDocument();
    expect(screen.getByText('Delivered cold and on time.')).toBeInTheDocument();
    expect(screen.getByLabelText('Rated 5.0 out of 5 stars')).toBeInTheDocument();
  });

  it('shows the product name only when asked', () => {
    const { rerender } = render(<ReviewList reviews={[review]} />);
    expect(screen.queryByText('On Fresh Snapper')).not.toBeInTheDocument();

    rerender(<ReviewList reviews={[review]} showProductName />);
    expect(screen.getByText('On Fresh Snapper')).toBeInTheDocument();
  });
});
