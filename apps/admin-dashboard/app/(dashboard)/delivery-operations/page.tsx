import { Suspense } from 'react';

import { DeliveryOperationsView } from '@/components/delivery-operations/delivery-operations-view';

export default function DeliveryOperationsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <DeliveryOperationsView />
    </Suspense>
  );
}
