import { Suspense } from 'react';

import { RecallsView } from '@/components/recalls/recalls-view';

export default function RecallsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <RecallsView />
    </Suspense>
  );
}
