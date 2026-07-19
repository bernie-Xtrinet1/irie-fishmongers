import { Suspense } from 'react';

import { VendorsView } from '@/components/vendors/vendors-view';

export default function VendorsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <VendorsView />
    </Suspense>
  );
}
