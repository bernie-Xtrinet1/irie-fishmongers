'use client';

import { isActiveAdministratorUser } from '@/lib/auth/admin-access';
import { useOptionalAuth } from '@/lib/auth/auth-context';
import { DriverSummaryCard } from './driver-summary-card';
import { FinancialSummaryCard } from './financial-summary-card';
import { OrdersSummaryCard } from './orders-summary-card';
import { VendorSummaryCard } from './vendor-summary-card';

// The KPI row - independently-refreshing widgets. FinancialSummaryCard is
// only mounted for full ADMINISTRATOR accounts; OPERATIONS_STAFF receives an
// operational summary without financials.
export function DashboardGrid(): React.ReactElement {
  const auth = useOptionalAuth();
  const showFinancials = !auth || isActiveAdministratorUser(auth.user);

  return (
    <div
      className={
        showFinancials
          ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'
          : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'
      }
    >
      {showFinancials ? <FinancialSummaryCard /> : null}
      <OrdersSummaryCard />
      <VendorSummaryCard />
      <DriverSummaryCard />
    </div>
  );
}
