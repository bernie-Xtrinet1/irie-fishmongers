import { Suspense } from 'react';

import { DeliveryZonesView } from '@/components/delivery-zones/delivery-zones-view';

export default function DeliveryZonesPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <DeliveryZonesView />
    </Suspense>
  );
}
