jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  PaymentMethod,
  UserRole,
} from '@prisma/client';
import { CashMovementsService } from './cash-movements.service';

describe('CashMovementsService', () => {
  it('lets admins register manual expenses in closed shifts', async () => {
    const movement = { id: 1, amount: 10 };
    const tx = {
      cashShift: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9,
          status: CashShiftStatus.CLOSED,
          openedById: 2,
        }),
      },
      cashMovement: { create: jest.fn().mockResolvedValue(movement) },
      auditLog: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const service = new CashMovementsService(prisma as any);

    await expect(
      service.expense(
        {
          cashShiftId: 9,
          category: CashMovementCategory.CASH_ADJUSTMENT,
          amount: 10,
          paymentMethod: PaymentMethod.CASH,
          description: 'Corrección caja cerrada',
        },
        { sub: 1, role: UserRole.ADMIN },
      ),
    ).resolves.toBe(movement);

    expect(tx.cashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cashShiftId: 9,
        type: CashMovementType.EXPENSE,
        amount: 10,
      }),
    });
  });
});
