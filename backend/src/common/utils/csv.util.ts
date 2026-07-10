// Hand-rolled CSV writer - the compliance report shapes are flat and small
// enough that a dependency (e.g. csv-stringify) isn't justified, per
// backend.md's "do not introduce alternative frameworks unless explicitly
// approved."
export function toCsv(rows: Array<Record<string, string>>): string {
  if (rows.length === 0) {
    return '';
  }

  const headers = Object.keys(rows.reduce((acc, row) => ({ ...acc, ...row }), {}));
  const escapeCell = (value: string): string => {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header] ?? '')).join(','));
  }
  return lines.join('\n');
}
