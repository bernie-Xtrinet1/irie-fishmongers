import {
  ComplianceBand,
  ReviewModerationStatus,
  type AdminReview,
  type AdminReviewDetail,
  type ComplianceScoreExplanation,
  type Paginated,
} from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useAdminReviewDetail,
  useAdminReviews,
  useComplianceScoreExplanation,
  useRemoveReview,
} from '@/lib/hooks/use-reviews';
import { ReviewsView } from './reviews-view';

jest.mock('@/lib/hooks/use-reviews');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reviews',
  useSearchParams: () => searchParams,
}));

const mockUseAdminReviews = useAdminReviews as jest.MockedFunction<typeof useAdminReviews>;
const mockUseAdminReviewDetail = useAdminReviewDetail as jest.MockedFunction<typeof useAdminReviewDetail>;
const mockUseRemoveReview = useRemoveReview as jest.MockedFunction<typeof useRemoveReview>;
const mockUseComplianceScoreExplanation = useComplianceScoreExplanation as jest.MockedFunction<
  typeof useComplianceScoreExplanation
>;

function review(overrides: Partial<AdminReview> = {}): AdminReview {
  return {
    id: 'review-1',
    authorId: 'customer-1',
    authorDisplayName: 'Bernard W.',
    vendorId: 'vendor-1',
    productId: null,
    productName: null,
    vendorOrderId: 'vo-1',
    rating: 5,
    title: 'Excellent',
    body: 'Very fresh snapper, delivered cold.',
    moderationStatus: ReviewModerationStatus.VISIBLE,
    removedById: null,
    removalReason: null,
    removedAt: null,
    deliveryWasRejected: false,
    editedAt: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<AdminReview>): UseQueryResult<Paginated<AdminReview>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<AdminReview>
  >;
}

describe('ReviewsView', () => {
  const removeMutateAsync = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    removeMutateAsync.mockReset().mockResolvedValue(review({ moderationStatus: ReviewModerationStatus.REMOVED_BY_ADMIN }));
    mockUseRemoveReview.mockReturnValue({
      mutateAsync: removeMutateAsync,
      isError: false,
    } as unknown as ReturnType<typeof useRemoveReview>);
    mockUseAdminReviewDetail.mockReturnValue({
      data: {
        ...review(),
        auditLogs: [],
      } as AdminReviewDetail,
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useAdminReviewDetail>);
    mockUseComplianceScoreExplanation.mockReturnValue({
      data: {
        vendorId: 'vendor-1',
        score: 82,
        band: ComplianceBand.GOOD,
        updatedAt: '2026-07-10T00:00:00.000Z',
        breakdown: {
          score: 82,
          temperatureDeduction: 5,
          inspectionDeduction: 8,
          recallDeduction: 0,
          certificationDeduction: 5,
        },
      } as ComplianceScoreExplanation,
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useComplianceScoreExplanation>);
  });

  it('shows an empty state when no reviews match the filters', () => {
    mockUseAdminReviews.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<ReviewsView />);

    expect(screen.getByText('No reviews match these filters.')).toBeInTheDocument();
  });

  it('renders review rows with the masked author, target, and status', () => {
    mockUseAdminReviews.mockReturnValue(withData({ items: [review()], total: 1, page: 1, pageSize: 20 }));

    render(<ReviewsView />);

    expect(screen.getByText('Bernard W.')).toBeInTheDocument();
    expect(screen.getByText('Vendor review')).toBeInTheDocument();
    expect(screen.getByText('Visible')).toBeInTheDocument();
  });

  it('hides the Remove action for an already admin-removed review', () => {
    mockUseAdminReviews.mockReturnValue(
      withData({
        items: [review({ moderationStatus: ReviewModerationStatus.REMOVED_BY_ADMIN })],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    );

    render(<ReviewsView />);

    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('removes a review with a required reason', async () => {
    mockUseAdminReviews.mockReturnValue(withData({ items: [review()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<ReviewsView />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove review' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Rating not supported by the review content');
    await user.click(within(dialog).getByRole('button', { name: 'Remove review' }));

    expect(removeMutateAsync).toHaveBeenCalledWith({
      reviewId: 'review-1',
      reason: 'Rating not supported by the review content',
    });
  });

  it('opens the detail dialog with the review body and compliance breakdown', async () => {
    mockUseAdminReviews.mockReturnValue(withData({ items: [review()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<ReviewsView />);

    await user.click(screen.getByRole('button', { name: 'View details' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Review details' });
    expect(within(dialog).getByText('Very fresh snapper, delivered cold.')).toBeInTheDocument();
    expect(within(dialog).getByText('No moderation actions recorded.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Inspections: -8/)).toBeInTheDocument();
  });
});
