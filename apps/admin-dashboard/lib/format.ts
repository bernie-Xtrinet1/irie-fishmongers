// Converts a SCREAMING_SNAKE_CASE enum value into readable Title Case,
// e.g. "READY_FOR_PICKUP" -> "Ready For Pickup".
export function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export function formatCurrency(amount: string, currency: string): string {
  return new Intl.NumberFormat('en-JM', { style: 'currency', currency }).format(Number(amount));
}
