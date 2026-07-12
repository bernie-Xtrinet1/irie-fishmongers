import { ApiProperty } from '@nestjs/swagger';
import { PaymentProviderName } from '@prisma/client';

export class TopProductEntity {
  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  quantitySold!: number;

  @ApiProperty({ description: 'sum(OrderItem.subtotal) where the order payment status=PAID, within the requested range' })
  revenue!: string;
}

export class CategorySalesEntity {
  @ApiProperty()
  categoryId!: string;

  @ApiProperty()
  categoryName!: string;

  @ApiProperty()
  quantitySold!: number;

  @ApiProperty({ description: 'sum(OrderItem.subtotal) for this category where the order payment status=PAID' })
  revenue!: string;
}

class SalesByPaymentMethodEntity implements Record<PaymentProviderName, string> {
  @ApiProperty({ description: 'sum(Payment.amount) where provider=WIPAY and status=PAID' })
  WIPAY!: string;

  @ApiProperty({ description: 'sum(Payment.amount) where provider=CASH_ON_DELIVERY and status=PAID' })
  CASH_ON_DELIVERY!: string;
}

export class SalesAnalyticsEntity {
  @ApiProperty({ type: TopProductEntity, isArray: true })
  topProductsByRevenue!: TopProductEntity[];

  @ApiProperty({ type: CategorySalesEntity, isArray: true })
  salesByCategory!: CategorySalesEntity[];

  @ApiProperty({ type: SalesByPaymentMethodEntity })
  salesByPaymentMethod!: SalesByPaymentMethodEntity;

  @ApiProperty({ description: 'grossPaidAmount / count(PAID payments), within the requested range' })
  averageOrderValue!: string;

  @ApiProperty()
  currency!: 'JMD';
}
