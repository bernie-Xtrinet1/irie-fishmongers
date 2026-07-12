import { Suspense } from 'react';

import { ColdChainView } from '@/components/cold-chain/cold-chain-view';

export default function ColdChainPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <ColdChainView />
    </Suspense>
  );
}
