import { Suspense } from 'react';

import { CataloguePhotosView } from '@/components/catalogue-photos/catalogue-photos-view';

export default function CataloguePhotosPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <CataloguePhotosView />
    </Suspense>
  );
}
