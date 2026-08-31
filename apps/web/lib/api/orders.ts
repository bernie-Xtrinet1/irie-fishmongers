import { apiGet } from '../api-client';

export interface OrderItemResponse {
  id: string;
  productId: string;
  productName: string;
  unitPrice: string;
  unit: string;
  quantity: number;
  subtotal: string;
}

export interface VendorOrderResponse {
  id: string;
  orderId: string;
  vendorId: string;
  status: string;
  subtotal: string;
  items: OrderItemResponse[];
  createdAt: string;
}

export interface OrderResponse {
  id: string;
  customerId: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2: string | null;
  deliveryParish: string;
  deliveryPhone: string;
  deliveryZoneId: string | null;
  vendorOrders: VendorOrderResponse[];
  payment?: unknown;
  paymentRedirectUrl?: string;
  createdAt: string;
}

export interface PaginatedOrdersResponse {
  items: OrderResponse[];
  total: number;
  page: number;
  pageSize: number;
}

export function getCustomerOrders(
  page = 1,
  pageSize = 20,
): Promise<PaginatedOrdersResponse> {
  return apiGet<PaginatedOrdersResponse>(
    `/orders?page=${page}&pageSize=${pageSize}`,
  );
}

export function getCustomerOrder(orderId: string): Promise<OrderResponse> {
  return apiGet<OrderResponse>(`/orders/${encodeURIComponent(orderId)}`);
}
