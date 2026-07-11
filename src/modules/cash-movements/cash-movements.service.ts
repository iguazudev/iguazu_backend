import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  PenaltyStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCashExpenseDto } from './dto/create-cash-expense.dto';
import { RecordCashMovementDto } from './dto/record-cash-movement.dto';

@Injectable()
export class CashMovementsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(data: RecordCashMovementDto, db: any = this.prisma) {
    if (Number(data.amount) <= 0) {
      throw new BadRequestException('El monto debe ser mayor a cero.');
    }

    const cashShift = data.cashShiftId
      ? await db.cashShift.findUnique({ where: { id: data.cashShiftId } })
      : await db.cashShift.findFirst({
          where: { status: CashShiftStatus.OPEN, openedById: data.userId },
        });

    if (
      !cashShift ||
      cashShift.status !== CashShiftStatus.OPEN ||
      cashShift.openedById !== data.userId
    ) {
      throw new NotFoundException('No tienes caja abierta.');
    }

    const movement = await db.cashMovement.create({
      data: {
        ...data,
        cashShiftId: cashShift.id,
      },
    });

    if (data.type === CashMovementType.EXPENSE) {
      await db.auditLog.create({
        data: {
          userId: data.userId,
          action: 'CASH_EXPENSE',
          entity: 'CashMovement',
          entityId: movement.id,
          newData: movement,
        },
      });
    }

    return movement;
  }

  findAll() {
    return this.prisma.cashMovement.findMany({
      orderBy: { occurredAt: 'desc' },
      include: { cashShift: true, user: { include: { employee: true } } },
    });
  }

  async findOne(id: number) {
    const movement = await this.prisma.cashMovement.findUnique({
      where: { id },
      include: { cashShift: true, user: { include: { employee: true } } },
    });

    if (!movement) {
      throw new NotFoundException('Movimiento de caja no encontrado.');
    }

    return movement;
  }

  byShift(cashShiftId: number) {
    return this.prisma.cashMovement.findMany({
      where: { cashShiftId },
      orderBy: { occurredAt: 'desc' },
      include: { user: { include: { employee: true } } },
    });
  }

  async expense(
    dto: CreateCashExpenseDto,
    user: { sub: number; role: UserRole; employeeId?: number | null },
  ) {
    const allowed: CashMovementCategory[] = [
      CashMovementCategory.CASH_WITHDRAWAL,
      CashMovementCategory.CASH_ADJUSTMENT,
      CashMovementCategory.INVENTORY_PURCHASE,
    ];
    if (!allowed.includes(dto.category)) {
      throw new BadRequestException('Categoría de egreso no permitida.');
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.record(
        {
          userId: user.sub,
          type: CashMovementType.EXPENSE,
          category: dto.category,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          description: dto.description,
          referenceType: 'MANUAL',
        },
        tx,
      );

      if (
        user.employeeId &&
        dto.category === CashMovementCategory.CASH_WITHDRAWAL
      ) {
        await tx.penalty.create({
          data: {
            employeeId: user.employeeId,
            amount: dto.amount,
            reason: `Salida de caja: ${dto.description ?? dto.category}`,
            date: new Date(),
            status: PenaltyStatus.PENDING,
          },
        });
      }

      return movement;
    });
  }

  async reverse(id: number, reason: string, userId: number) {
    const original = await this.prisma.cashMovement.findUnique({
      where: { id },
    });
    if (!original) {
      throw new NotFoundException('Movimiento de caja no encontrado.');
    }

    // Tipo opuesto: INCOME → EXPENSE, EXPENSE → INCOME.
    const reverseType: CashMovementType =
      original.type === CashMovementType.INCOME
        ? CashMovementType.EXPENSE
        : CashMovementType.INCOME;

    // La reversa va a la caja abierta del usuario actual.
    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: userId },
    });
    if (!openShift) {
      throw new NotFoundException('No tienes caja abierta.');
    }

    return this.prisma.$transaction(async (tx) => {
      const reversal = await tx.cashMovement.create({
        data: {
          cashShiftId: openShift.id,
          userId,
          type: reverseType,
          category: original.category,
          amount: original.amount,
          paymentMethod: original.paymentMethod,
          description: `Reversa: ${original.description ?? ''} | ${reason}`,
          referenceType: 'MANUAL_REVERSAL',
          referenceId: original.id,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: 'CASH_MOVEMENT_REVERSE',
          entity: 'CashMovement',
          entityId: reversal.id,
          newData: { originalId: original.id, reason },
        },
      });

      return reversal;
    });
  }
}
