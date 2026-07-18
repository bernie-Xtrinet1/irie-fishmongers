import { Suspense } from 'react';

import { ReviewsView } from '@/components/reviews/reviews-view';

export default function ReviewsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <ReviewsView />
    </Suspense>
  );
}
