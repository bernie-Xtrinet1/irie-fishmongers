import { Suspense } from 'react';

import { DriversView } from '@/components/drivers/drivers-view';

export default function DriversPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <DriversView />
    </Suspense>
  );
}
