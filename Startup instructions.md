
Create all documentation first:
docs/
rules/
adr/
Set up the monorepo.
Build strictly in this order:
Authentication
Vendors
Products
Orders
Allocation Engine
Payments
Delivery
Driver Settlements
Vendor Settlements
Food Safety
Reporting
Mobile Apps
Use one GitHub feature branch per phase.
Merge into develop, then main.