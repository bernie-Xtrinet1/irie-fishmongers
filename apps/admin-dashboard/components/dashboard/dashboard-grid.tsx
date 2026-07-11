import { DriverSummaryCard } from './driver-summary-card';
import { FinancialSummaryCard } from './financial-summary-card';
import { OrdersSummaryCard } from './orders-summary-card';
import { VendorSummaryCard } from './vendor-summary-card';

// The KPI row - four independently-refreshing widgets. Each owns its own
// query, so this component itself has no data-fetching responsibility.
export function DashboardGrid(): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <FinancialSummaryCard />
      <OrdersSummaryCard />
      <VendorSummaryCard />
      <DriverSummaryCard />
    </div>
  );
}
