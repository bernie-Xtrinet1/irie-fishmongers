import { Suspense } from 'react';

import { CataloguePhotoStaffAccessView } from '@/components/catalogue-photos/catalogue-photo-staff-access-view';

export default function CataloguePhotoStaffAccessPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <CataloguePhotoStaffAccessView />
    </Suspense>
  );
}
