import { describe, it, expect } from 'vitest';
import { buildExpenditure } from './escpos';

describe('buildExpenditure', () => {
  it('prints the provided approvedByName on the expenditure', () => {
    const data = {
      expenditureNo: 1,
      expenditureDate: '2026-07-06',
      paidToType: 'STAFF',
      paidToName: 'Raja behar',
      amount: 500,
      narration: 'Test advance',
      approvedByName: 'Admin User',
      status: 'UNVERIFIED',
      restaurant: { name: 'Test Restaurant' },
    };
    const out = buildExpenditure(data as any);
    const raw = (out[0] as any).data as string;
    expect(raw).toContain('Paid To    : Raja behar');
    expect(raw).toContain('Approved By: Admin User');
  });

  it('omits the approvedBy line when no approver is provided', () => {
    const data = {
      expenditureNo: 2,
      expenditureDate: '2026-07-06',
      paidToType: 'STAFF',
      paidToName: 'Raja behar',
      amount: 500,
      status: 'UNVERIFIED',
      restaurant: { name: 'Test Restaurant' },
    };
    const out = buildExpenditure(data as any);
    const raw = (out[0] as any).data as string;
    expect(raw).toContain('Paid To    : Raja behar');
    expect(raw).not.toContain('Approved By:');
  });
});
