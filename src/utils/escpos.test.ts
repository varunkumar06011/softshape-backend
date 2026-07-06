import { describe, it, expect } from 'vitest';
import { buildVoucher } from './escpos';

describe('buildVoucher', () => {
  it('prints the provided approvedByName on the voucher', () => {
    const data = {
      voucherNo: 1,
      voucherDate: '2026-07-06',
      paidToType: 'STAFF',
      paidToName: 'Raja behar',
      amount: 500,
      narration: 'Test advance',
      approvedByName: 'Admin User',
      status: 'UNVERIFIED',
      restaurant: { name: 'Test Restaurant' },
    };
    const out = buildVoucher(data as any);
    const raw = (out[0] as any).data as string;
    expect(raw).toContain('Paid To    : Raja behar');
    expect(raw).toContain('Approved By: Admin User');
  });

  it('omits the approvedBy line when no approver is provided', () => {
    const data = {
      voucherNo: 2,
      voucherDate: '2026-07-06',
      paidToType: 'STAFF',
      paidToName: 'Raja behar',
      amount: 500,
      status: 'UNVERIFIED',
      restaurant: { name: 'Test Restaurant' },
    };
    const out = buildVoucher(data as any);
    const raw = (out[0] as any).data as string;
    expect(raw).toContain('Paid To    : Raja behar');
    expect(raw).not.toContain('Approved By:');
  });
});
