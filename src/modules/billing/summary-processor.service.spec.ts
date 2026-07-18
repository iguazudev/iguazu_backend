jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { InvoiceStatus } from '@prisma/client';
import { SummaryProcessorService } from './summary-processor.service';

describe('SummaryProcessorService', () => {
  it('does not mix invoice issue dates in the same daily summary', async () => {
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          invoice(1, 'B001-00000001', '2026-07-17T12:00:00.000Z'),
          invoice(2, 'B001-00000002', '2026-07-18T12:00:00.000Z'),
        ]),
        updateMany: jest.fn(),
      },
    };
    const summaryBuilder = {
      build: jest.fn().mockReturnValue('<SummaryDocuments />'),
    };
    const service = new SummaryProcessorService(
      prisma as any,
      {} as any,
      { nextCorrelativo: jest.fn().mockResolvedValue(9) } as any,
      summaryBuilder as any,
      { sign: jest.fn().mockResolvedValue('<SignedSummaryDocuments />') } as any,
      { makeZipBase64: jest.fn().mockReturnValue('zip-base64') } as any,
      { sendSummary: jest.fn().mockResolvedValue({ ticket: '123' }) } as any,
      {} as any,
    );

    const result = await service.sendDailySummary();

    expect(result.includedCount).toBe(1);
    expect(result.summaryFileName).toBe('undefined-RC-20260717-9');
    expect(summaryBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceDate: '2026-07-17',
        lines: [expect.objectContaining({ correlativo: '00000001' })],
      }),
    );
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1] } } }),
    );
  });
});

function invoice(id: number, docNumber: string, issueDate: string) {
  return {
    id,
    invoiceType: '03',
    docNumber,
    customerDocType: '1',
    customerDocNumber: '12345678',
    taxableAmount: { toString: () => '33.90' },
    taxAmount: { toString: () => '6.10' },
    total: { toString: () => '40.00' },
    issueDate: new Date(issueDate),
    status: InvoiceStatus.PENDING,
  };
}
