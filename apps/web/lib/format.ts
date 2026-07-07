// Converts a SCREAMING_SNAKE_CASE enum value (Parish, VendorComplianceStatusLabel,
// FreshnessGrade, ...) into readable Title Case, e.g. "ST_ANDREW" -> "St Andrew".
export function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-JM', { year: 'numeric', month: 'long', day: 'numeric' });
}
