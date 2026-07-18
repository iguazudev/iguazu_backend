jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import {
  CashMovementCategory,
  CashMovementType,
  PaymentMethod,
  SaleItemType,
  SaleStatus,
  UserRole,
} from '@prisma/client';
import { SalesService } from './sales.service';

describe('SalesService', () => {
  it('cancels a paid sale in the sale cash shift, not the current open shift', async () => {
    const sale = {
      id: 71,
      cashShiftId: 9,
      status: SaleStatus.PAID,
      invoice: null,
      payments: [
        {
          amount: 10,
          paymentMethod: PaymentMethod.CASH,
          cashMovement: { category: CashMovementCategory.PRODUCT_SALE },
        },
      ],
      details: [
        {
          itemType: SaleItemType.PRODUCT,
          productId: 3,
          quantity: 1,
        },
      ],
    };
    const tx = {
      product: { update: jest.fn() },
      inventoryMovement: { create: jest.fn() },
      cashMovement: { create: jest.fn() },
      sale: { update: jest.fn().mockResolvedValue({ id: 71, status: SaleStatus.CANCELLED }) },
    };
    const prisma = {
      sale: { findUnique: jest.fn().mockResolvedValue(sale) },
      cashShift: { findFirst: jest.fn().mockResolvedValue({ id: 16 }) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new SalesService(prisma as any, {} as any);

    await service.cancel(
      71,
      { reason: 'Venta creada en caja equivocada' },
      { sub: 1, role: UserRole.ADMIN },
    );

    expect(prisma.cashShift.findFirst).not.toHaveBeenCalled();
    expect(tx.cashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cashShiftId: 9,
        type: CashMovementType.EXPENSE,
        amount: 10,
        referenceType: 'SALE_VOID',
      }),
    });
  });
});
