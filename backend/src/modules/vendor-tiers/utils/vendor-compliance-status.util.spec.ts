import { deriveVendorComplianceStatus } from './vendor-compliance-status.util';

describe('deriveVendorComplianceStatus', () => {
  it('returns NOT_YET_ASSESSED for a null score', () => {
    expect(deriveVendorComplianceStatus(null)).toBe('NOT_YET_ASSESSED');
  });

  it('returns COMPLIANT at or above 80', () => {
    expect(deriveVendorComplianceStatus(80)).toBe('COMPLIANT');
    expect(deriveVendorComplianceStatus(100)).toBe('COMPLIANT');
  });

  it('returns AT_RISK between 50 and 79', () => {
    expect(deriveVendorComplianceStatus(50)).toBe('AT_RISK');
    expect(deriveVendorComplianceStatus(79)).toBe('AT_RISK');
  });

  it('returns NON_COMPLIANT below 50', () => {
    expect(deriveVendorComplianceStatus(0)).toBe('NON_COMPLIANT');
    expect(deriveVendorComplianceStatus(49)).toBe('NON_COMPLIANT');
  });
});
