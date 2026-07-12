import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  InventoryMovementType,
  PaymentMethod,
  SaleStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloseCashShiftDto } from './dto/close-cash-shift.dto';
import { SettleDifferenceDto } from './dto/settle-difference.dto';

@Injectable()
export class CashClosuresService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(userId: number) {
    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: userId },
      include: this.shiftInclude(),
    });
    if (!openShift) throw new NotFoundException('No tienes caja abierta.');

    return this.shiftSummary(openShift);
  }

  async close(dto: CloseCashShiftDto, userId: number) {
    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: userId },
      include: {
        ...this.shiftInclude(),
        closure: true,
      },
    });
    if (!openShift) throw new NotFoundException('No tienes caja abierta.');
    if (openShift.closure)
      throw new BadRequestException('La caja ya fue cerrada.');

    const counted = new Map(
      dto.countedAmounts.map((item) => [
        item.paymentMethod,
        item.countedAmount,
      ]),
    );
    const methods = Object.values(PaymentMethod);

    const details = methods.map((paymentMethod) => {
      const expectedAmount = this.expectedForMethod(
        openShift,
        openShift.cashMovements,
        paymentMethod,
      );
      const countedAmount = counted.get(paymentMethod) ?? 0;
      return {
        paymentMethod,
        expectedAmount,
        countedAmount,
        difference: Number((countedAmount - expectedAmount).toFixed(2)),
      };
    });

    const totalExpected = this.sum(
      details.map((detail) => detail.expectedAmount),
    );
    const totalCounted = this.sum(
      details.map((detail) => detail.countedAmount),
    );

    const closure = await this.prisma.$transaction(async (tx) => {
      const updatedShift = await tx.cashShift.updateMany({
        where: {
          id: openShift.id,
          openedById: userId,
          status: CashShiftStatus.OPEN,
        },
        data: {
          status: CashShiftStatus.CLOSED,
          closedById: userId,
          closedAt: new Date(),
        },
      });
      if (updatedShift.count !== 1) {
        throw new ForbiddenException(
          'Solo el usuario que abrió la caja puede cerrarla.',
        );
      }

      const closure = await tx.cashClosure.create({
        data: {
          cashShiftId: openShift.id,
          totalExpected,
          totalCounted,
          difference: Number((totalCounted - totalExpected).toFixed(2)),
          notes: dto.notes,
          details: { create: details },
        },
        include: { details: true, cashShift: true },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: 'CASH_CLOSE',
          entity: 'CashClosure',
          entityId: closure.id,
          newData: closure as any,
        },
      });

      return closure;
    });

    return this.findOne(closure.id);
  }

  async findAll() {
    const closures = await this.prisma.cashClosure.findMany({
      orderBy: { createdAt: 'desc' },
      include: { cashShift: { include: this.shiftInclude() }, details: true },
    });

    return Promise.all(
      closures.map(async (closure) => ({
        ...closure,
        summary: await this.shiftSummary(closure.cashShift),
      })),
    );
  }

  async findOne(id: number) {
    const closure = await this.prisma.cashClosure.findUnique({
      where: { id },
      include: { cashShift: { include: this.shiftInclude() }, details: true },
    });
    if (!closure) throw new NotFoundException('Cierre de caja no encontrado.');
    return { ...closure, summary: await this.shiftSummary(closure.cashShift) };
  }

  private shiftInclude() {
    return {
      openedBy: { include: { employee: true } },
      closedBy: { include: { employee: true } },
      cashMovements: true,
      sales: { include: { details: true, payments: true } },
    };
  }

  private async shiftSummary(shift: any) {
    const movements = shift.cashMovements ?? [];
    const sales = shift.sales ?? [];
    const methods = Object.values(PaymentMethod);
    const expectedByMethod = Object.fromEntries(
      methods.map((method) => [
        method,
        this.expectedForMethod(shift, movements, method),
      ]),
    );
    // Nota: las pérdidas se filtran por rango del turno. Si dos turnos se
    // solapan en tiempo (raro en hotel chico) puede haber leve doble conteo.
    // Para hacerlo exacto haría falta cashShiftId en InventoryMovement (etapa futura).
    const losses = await this.prisma.inventoryMovement.findMany({
      where: {
        type: InventoryMovementType.LOSS,
        createdAt: {
          gte: shift.openedAt,
          lte: shift.closedAt ?? new Date(),
        },
      },
      include: { product: true },
    });
    const activeSales = sales.filter(
      (sale: any) => sale.status !== SaleStatus.CANCELLED,
    );
    const paidSales = activeSales.filter((sale: any) => sale.status === SaleStatus.PAID);
    const pendingSales = activeSales.filter(
      (sale: any) => sale.status === SaleStatus.OPEN,
    );

    return {
      shiftId: shift.id,
      openedBy: shift.openedBy?.employee?.fullName ?? shift.openedBy?.username,
      closedBy: shift.closedBy?.employee?.fullName ?? shift.closedBy?.username,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      openingAmount: Number(shift.openingAmount),
      expectedByMethod,
      totalExpected: this.sum(Object.values(expectedByMethod).map(Number)),
      salesCount: activeSales.length,
      paidSalesCount: paidSales.length,
      pendingSalesCount: pendingSales.length,
      salesTotal: this.sum(activeSales.map((sale: any) => Number(sale.total))),
      paidSalesTotal: this.sum(paidSales.map((sale: any) => Number(sale.total))),
      pendingSalesTotal: this.sum(
        pendingSales.map((sale: any) => Number(sale.total)),
      ),
      incomeTotal: this.sum(
        movements
          .filter((movement: any) => movement.type === CashMovementType.INCOME)
          .map((movement: any) => Number(movement.amount)),
      ),
      expenseTotal: this.sum(
        movements
          .filter((movement: any) => movement.type === CashMovementType.EXPENSE)
          .map((movement: any) => Number(movement.amount)),
      ),
      lossCount: losses.length,
      lossTotal: this.sum(
        losses.map(
          (loss) => Number(loss.quantity) * Number(loss.product.purchasePrice),
        ),
      ),
    };
  }

  private expectedForMethod(
    shift: { openingAmount: unknown },
    movements: any[],
    paymentMethod: PaymentMethod,
  ) {
    const movementTotal = this.sum(
      movements
        .filter((movement) => movement.paymentMethod === paymentMethod)
        .map((movement) =>
          movement.type === CashMovementType.INCOME
            ? Number(movement.amount)
            : -Number(movement.amount),
        ),
    );

    return this.sum([
      movementTotal,
      paymentMethod === PaymentMethod.CASH ? Number(shift.openingAmount) : 0,
    ]);
  }

  private sum(values: number[]) {
    return Number(
      values.reduce((total, value) => total + Number(value), 0).toFixed(2),
    );
  }

  async reopen(closureId: number, user: { sub: number; role: UserRole }) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Solo ADMIN puede reabrir caja.');
    }

    const closure = await this.prisma.cashClosure.findUnique({
      where: { id: closureId },
      include: { cashShift: true, details: true },
    });
    if (!closure) {
      throw new NotFoundException('Cierre de caja no encontrado.');
    }

    const shift = closure.cashShift;
    if (shift.status !== CashShiftStatus.CLOSED) {
      throw new BadRequestException('La caja no está cerrada.');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Eliminar el cierre y su detalle (vuelve a estado sin arqueo).
      await tx.cashClosureDetail.deleteMany({
        where: { cashClosureId: closureId },
      });
      await tx.cashClosure.delete({ where: { id: closureId } });

      // 2. Reabrir la caja.
      const reopened = await tx.cashShift.update({
        where: { id: shift.id },
        data: {
          status: CashShiftStatus.OPEN,
          closedById: null,
          closedAt: null,
        },
        include: this.shiftInclude(),
      });

      // 3. Auditoría.
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          action: 'CASH_REOPEN',
          entity: 'CashClosure',
          entityId: closureId,
          newData: { cashShiftId: shift.id },
        },
      });

      return reopened;
    });
  }

  /**
   * Cuadra la diferencia de un cierre creando un CashMovement compensatorio.
   *
   * - difference < 0 (faltante)  → EXPENSE CASH_ADJUSTMENT (se repone/asume la pérdida).
   * - difference > 0 (sobrante)  → INCOME CASH_ADJUSTMENT (se registra el excedente).
   *
   * El movimiento se asocia a la caja ABIERTA del usuario que cuadra (típicamente
   * el turno siguiente, o el admin que reabrió). Así el próximo turno arranca
   * cuadrado y el ajuste queda documentado y trazable.
   */
  async settleDifference(
    closureId: number,
    dto: SettleDifferenceDto,
    user: { sub: number; role: UserRole },
  ) {
    const closure = await this.prisma.cashClosure.findUnique({
      where: { id: closureId },
      include: { cashShift: true },
    });
    if (!closure) {
      throw new NotFoundException('Cierre de caja no encontrado.');
    }
    if (closure.settled) {
      throw new BadRequestException('Este cierre ya fue cuadrado.');
    }

    const difference = Number(closure.difference);
    if (difference === 0) {
      throw new BadRequestException('La caja cuadró exactamente. No hay nada que cuadrar.');
    }

    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: user.sub },
    });
    if (!openShift) {
      throw new NotFoundException('No tienes caja abierta para registrar el ajuste.');
    }

    const isShort = difference < 0;
    const absDiff = Number(Math.abs(difference).toFixed(2));
    const movementType = isShort
      ? CashMovementType.EXPENSE
      : CashMovementType.INCOME;
    const label = isShort ? 'Faltante' : 'Sobrante';

    return this.prisma.$transaction(async (tx) => {
      // 1. Movimiento compensatorio en la caja abierta actual.
      const movement = await tx.cashMovement.create({
        data: {
          cashShiftId: openShift.id,
          userId: user.sub,
          type: movementType,
          category: CashMovementCategory.CASH_ADJUSTMENT,
          amount: absDiff,
          paymentMethod: PaymentMethod.CASH,
          description: `${label} de cierre #${closure.id}: ${dto.reason}`,
          referenceType: 'CASH_SETTLE',
          referenceId: closure.id,
        },
      });

      // 2. Marcar el cierre como cuadrado.
      const updated = await tx.cashClosure.update({
        where: { id: closureId },
        data: {
          settled: true,
          settledAt: new Date(),
          settledById: user.sub,
          settleReason: dto.reason,
          settleCashMovementId: movement.id,
        },
        include: { details: true, cashShift: true },
      });

      // 3. Auditoría.
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          action: 'CASH_SETTLE',
          entity: 'CashClosure',
          entityId: closureId,
          newData: {
            difference,
            reason: dto.reason,
            cashMovementId: movement.id,
          },
        },
      });

      return {
        ...updated,
        settle: {
          label,
          amount: absDiff,
          cashMovementId: movement.id,
          reason: dto.reason,
        },
      };
    });
  }
}
