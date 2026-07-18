jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { InvoiceStatus, SaleStatus } from '@prisma/client';
import { BillingService } from './billing.service';

describe('BillingService', () => {
  it('sends boletas individually with sendBill', async () => {
    const prisma = {
      sale: {
        findUnique: jest.fn().mockResolvedValue({
          id: 43,
          status: SaleStatus.PAID,
          total: 50,
          customer: {
            documentNumber: '72093905',
            fullName: 'Gorge pucahuanca gonzales',
            businessName: null,
            address: '',
          },
          invoice: null,
          details: [
            {
              description: 'Alojamiento Hab. 215',
              quantity: 1,
              unitPrice: 50,
              subtotal: 50,
            },
          ],
        }),
      },
    };
    const invoices = {
      nextCorrelativo: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({
        id: 5,
        issueDate: new Date('2026-07-17T23:02:27.000Z'),
      }),
      update: jest.fn(),
    };
    const sunat = { sendBill: jest.fn().mockResolvedValue({ cdrBase64: 'cdr' }) };
    const summaryProcessor = { sendDailySummary: jest.fn() };
    const service = new BillingService(
      prisma as any,
      config() as any,
      invoices as any,
      { buildInvoice: jest.fn().mockReturnValue('<Invoice />') } as any,
      { sign: jest.fn().mockResolvedValue('<SignedInvoice />') } as any,
      { makeZipBase64: jest.fn().mockReturnValue('zip') } as any,
      sunat as any,
      { unzip: jest.fn().mockReturnValue({ responseCode: '0', description: 'Aceptado', xmlContent: '<DigestValue>abc</DigestValue>' }) } as any,
      { generate: jest.fn().mockResolvedValue('pdf') } as any,
      {} as any,
      summaryProcessor as any,
    );

    const result = await service.issueFromSale(43, { invoiceType: '03' }, 1);

    expect(sunat.sendBill).toHaveBeenCalledWith('zip', '10415464211-03-B001-00000001');
    expect(summaryProcessor.sendDailySummary).not.toHaveBeenCalled();
    expect(invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceType: '03',
        status: InvoiceStatus.ACCEPTED,
        ticket: null,
        summaryStatus: null,
      }),
    );
    expect(result.status).toBe(InvoiceStatus.ACCEPTED);
  });
});

function config() {
  return {
    modo: 'produccion',
    endpoint: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
    usuario: '10415464211IGUAZUCP',
    ruc: '10415464211',
    emisor: {
      ruc: '10415464211',
      razonSocial: 'CASTILLO MORALES ANDRES',
      nombreComercial: 'CASTILLO MORALES ANDRES',
      address: {
        ubigeo: '140101',
        addressTypeCode: '0001',
        cityName: 'HUANCAYO',
        countrySubentity: 'JUNIN',
        district: 'HUANCAYO',
        line: '-',
        countryCode: 'PE',
      },
    },
  };
}
