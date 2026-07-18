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
import { CashMovementQueryDto } from './dto/cash-movement-query.dto';
import { RecordCashMovementDto } from './dto/record-cash-movement.dto';

const movementInclude = {
  cashShift: {
    include: {
      openedBy: { include: { employee: true } },
      closedBy: { include: { employee: true } },
    },
  },
  user: { include: { employee: true } },
  salePayment: {
    include: {
      sale: {
        include: {
          customer: true,
          stay: { include: { room: true } },
          details: { include: { product: true } },
        },
      },
    },
  },
  staffAdvance: { include: { employee: true } },
  staffPayment: { include: { employee: true } },
  staffDiscount: { include: { employee: true } },
};

@Injectable()
export class CashMovementsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    data: RecordCashMovementDto,
    db: any = this.prisma,
    options: { allowClosedShiftForAdmin?: boolean } = {},
  ) {
    if (Number(data.amount) <= 0) {
      throw new BadRequestException('El monto debe ser mayor a cero.');
    }
    if (data.actorRole === UserRole.ADMIN && !data.cashShiftId) {
      throw new BadRequestException('Selecciona una caja abierta.');
    }

    const cashShift = data.cashShiftId
      ? await db.cashShift.findUnique({ where: { id: data.cashShiftId } })
      : await db.cashShift.findFirst({
          where: { status: CashShiftStatus.OPEN, openedById: data.userId },
        });
    const adminClosedAllowed =
      options.allowClosedShiftForAdmin &&
      data.actorRole === UserRole.ADMIN &&
      Boolean(data.cashShiftId);

    if (
      !cashShift ||
      (!adminClosedAllowed && cashShift.status !== CashShiftStatus.OPEN) ||
      (cashShift.openedById !== data.userId && data.actorRole !== UserRole.ADMIN)
    ) {
      throw new NotFoundException('No tienes caja abierta.');
    }

    const { actorRole: _actorRole, ...movementData } = data;
    const movement = await db.cashMovement.create({
      data: {
        ...movementData,
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

  async findAll(user: AuthUser, query: CashMovementQueryDto = {}) {
    const cashShiftWhere: any = {};
    if (user.role !== UserRole.ADMIN) cashShiftWhere.openedById = this.userId(user);
    if (user.role === UserRole.ADMIN && query.userId) cashShiftWhere.openedById = query.userId;
    if (query.openedDate) {
      const start = new Date(`${query.openedDate}T00:00:00`);
      const end = new Date(`${query.openedDate}T23:59:59.999`);
      cashShiftWhere.openedAt = { gte: start, lte: end };
    }
    if (query.workShift) {
      const shifts = await this.prisma.cashShift.findMany({
        where: cashShiftWhere,
        select: { id: true, openedAt: true },
        orderBy: { openedAt: 'desc' },
        take: 500,
      });
      cashShiftWhere.id = {
        in: shifts
          .filter((shift) => this.workShift(shift.openedAt) === query.workShift)
          .map((shift) => shift.id),
      };
    }
    const movements = await this.prisma.cashMovement.findMany({
      where: {
        ...(query.cashShiftId ? { cashShiftId: query.cashShiftId } : {}),
        ...(Object.keys(cashShiftWhere).length ? { cashShift: cashShiftWhere } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit ?? 100,
      include: movementInclude,
    });
    return this.withReferenceSales(movements);
  }

  async findOne(id: number, user: AuthUser) {
    const movement = await this.prisma.cashMovement.findUnique({
      where: { id },
      include: movementInclude,
    });

    if (
      !movement ||
      (user.role !== UserRole.ADMIN && movement.cashShift.openedById !== this.userId(user))
    ) {
      throw new NotFoundException('Movimiento de caja no encontrado.');
    }

    return (await this.withReferenceSales([movement]))[0];
  }

  async byShift(cashShiftId: number, user: AuthUser) {
    const movements = await this.prisma.cashMovement.findMany({
      where:
        user.role === UserRole.ADMIN
          ? { cashShiftId }
          : { cashShiftId, cashShift: { openedById: this.userId(user) } },
      orderBy: { occurredAt: 'desc' },
      include: movementInclude,
    });
    return this.withReferenceSales(movements);
  }

  private workShift(openedAt: Date) {
    const hour = openedAt.getHours();
    return hour >= 15 || hour < 6 ? 'NIGHT' : 'DAY';
  }

  async expense(
    dto: CreateCashExpenseDto,
    user: AuthUser & { employeeId?: number | null },
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
          cashShiftId: dto.cashShiftId,
          userId: this.userId(user),
          actorRole: user.role,
          type: CashMovementType.EXPENSE,
          category: dto.category,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          description: dto.description,
          referenceType: 'MANUAL',
        },
        tx,
        { allowClosedShiftForAdmin: true },
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

  private userId(user: AuthUser) {
    const id = user.sub ?? user.id;
    if (!id) throw new NotFoundException('Movimiento de caja no encontrado.');
    return id;
  }

  private async withReferenceSales<T extends { referenceType: string | null; referenceId: number | null; salePayment?: any }>(
    movements: T[],
  ) {
    const saleIds = movements
      .filter((movement) => !movement.salePayment && ['SALE', 'SALE_VOID'].includes(String(movement.referenceType)))
      .map((movement) => movement.referenceId)
      .filter((id): id is number => typeof id === 'number');
    if (!saleIds.length) {
      return movements.map((movement) => ({
        ...movement,
        amount: movement.salePayment?.amount ?? (movement as any).amount,
      }));
    }

    const sales = await this.prisma.sale.findMany({
      where: { id: { in: [...new Set(saleIds)] } },
      include: {
        customer: true,
        stay: { include: { room: true } },
        details: { include: { product: true } },
      },
    });
    const salesById = new Map(sales.map((sale) => [sale.id, sale]));
    return movements.map((movement) => ({
      ...movement,
      amount: movement.salePayment?.amount ?? (movement as any).amount,
      referenceSale: movement.referenceId ? salesById.get(movement.referenceId) : undefined,
    }));
  }
}

type AuthUser = { sub?: number; id?: number; role: UserRole };
