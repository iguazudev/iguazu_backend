import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CashMovementType,
  InventoryMovementType,
  PaymentMethod,
  SaleItemType,
  SaleStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ReportQueryDto } from './dto/report-query.dto';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async cashSummary(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const where = query.cashShiftId
      ? { id: query.cashShiftId, ...this.cashShiftOwnerWhere(user) }
      : {
          openedAt: { gte: start, lte: end },
          ...(user?.role === UserRole.ADMIN && query.userId ? { openedById: query.userId } : {}),
          ...this.cashShiftOwnerWhere(user),
        };
    const shifts = await this.prisma.cashShift.findMany({
      where,
      include: {
        openedBy: { include: { employee: true } },
        closedBy: { include: { employee: true } },
        cashMovements: {
          include: {
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
          },
        },
        sales: true,
        closure: {
          include: {
            details: true,
            settledBy: { include: { employee: true } },
          },
        },
      },
      orderBy: { openedAt: 'desc' },
    });

    const movements = shifts.flatMap((shift) => shift.cashMovements);
    const sales = shifts.flatMap((shift) => shift.sales);
    const activeSales = sales.filter(
      (sale) => sale.status !== SaleStatus.CANCELLED,
    );
    const cancelledSales = sales.filter(
      (sale) => sale.status === SaleStatus.CANCELLED,
    );
    const closures = shifts.flatMap((shift) =>
      shift.closure ? [{ ...shift.closure, shift }] : [],
    );
    const currentClosures = closures.map((closure) =>
      this.currentClosureTotals(closure),
    );

    return {
      range: { from: start, to: end },
      shifts: shifts.length,
      salesCount: activeSales.length,
      paidSalesCount: activeSales.filter((sale) => sale.status === SaleStatus.PAID).length,
      pendingSalesCount: activeSales.filter((sale) => sale.status === SaleStatus.OPEN).length,
      cancelledSalesCount: cancelledSales.length,
      cancelledSalesTotal: this.sum(
        cancelledSales.map((sale) => Number(sale.total)),
      ),
      openingAmount: this.sum(shifts.map((shift) => Number(shift.openingAmount))),
      incomeTotal: this.sum(
        movements
          .filter((movement) => movement.type === CashMovementType.INCOME)
          .map((movement) => this.movementAmount(movement)),
      ),
      expenseTotal: this.sum(
        movements
          .filter((movement) => movement.type === CashMovementType.EXPENSE)
          .map((movement) => this.movementAmount(movement)),
      ),
      expectedTotal: this.sum(currentClosures.map((closure) => Number(closure.totalExpected))),
      countedTotal: this.sum(currentClosures.map((closure) => Number(closure.totalCounted))),
      differenceTotal: this.sum(currentClosures.map((closure) => Number(closure.difference))),
      // Cuadres pendientes: cierres con diferencia != 0 que aún no fueron cuadrados.
      unsettledCount: currentClosures.filter(
        (closure) => Number(closure.difference) !== 0 && !closure.settled,
      ).length,
      unsettledTotal: this.sum(
        currentClosures
          .filter((closure) => Number(closure.difference) !== 0 && !closure.settled)
          .map((closure) => Number(closure.difference)),
      ),
      closures: currentClosures.map((closure) => ({
        id: closure.id,
        cashShiftId: closure.cashShiftId,
        openedBy: closure.shift.openedBy.employee?.fullName ?? closure.shift.openedBy.username,
        closedBy: closure.shift.closedBy?.employee?.fullName ?? closure.shift.closedBy?.username,
        totalExpected: Number(closure.totalExpected),
        totalCounted: Number(closure.totalCounted),
        difference: Number(closure.difference),
        createdAt: closure.createdAt,
        settled: closure.settled,
        settledAt: closure.settledAt,
        settledBy: closure.settledBy?.employee?.fullName ?? closure.settledBy?.username,
        settleReason: closure.settleReason,
      })),
      movements: movements.map((movement: any) => ({
        id: movement.id,
        cashShiftId: movement.cashShiftId,
        type: movement.type,
        category: movement.category,
        paymentMethod: movement.paymentMethod,
        amount: this.movementAmount(movement),
        user: movement.user?.employee?.fullName ?? movement.user?.username ?? '-',
        description: movement.description,
        occurredAt: movement.occurredAt,
        saleId: movement.salePayment?.sale?.id ?? null,
        customer: movement.salePayment?.sale?.customer?.fullName ?? 'Consumidor final',
        room: movement.salePayment?.sale?.stay?.room?.roomNumber ?? null,
        details: this.saleDetailsText(movement.salePayment?.sale?.details ?? []),
      })),
    };
  }

  async salesSummary(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const sales = await this.prisma.sale.findMany({
      where: this.saleWhere(query, start, end, user),
      include: { payments: true, user: { include: { employee: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const payments = sales.flatMap((sale) => sale.payments);

    return {
      range: { from: start, to: end },
      count: sales.length,
      total: this.sum(sales.map((sale) => Number(sale.total))),
      paidTotal: this.sum(
        sales
          .filter((sale) => sale.status === SaleStatus.PAID)
          .map((sale) => Number(sale.total)),
      ),
      pendingTotal: this.sum(
        sales
          .filter((sale) => sale.status === SaleStatus.OPEN)
          .map((sale) => Number(sale.total)),
      ),
      byStatus: this.groupSum(sales, 'status', 'total'),
      byPaymentMethod: this.groupSum(payments, 'paymentMethod', 'amount'),
      byUser: this.groupSum(
        sales.map((sale) => ({
          ...sale,
          userName: sale.user.employee?.fullName ?? sale.user.username,
        })),
        'userName',
        'total',
      ),
    };
  }

  async salesByItemType(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const details = await this.prisma.saleDetail.findMany({
      where: { sale: this.saleWhere(query, start, end, user) },
      include: { sale: true },
    });

    return {
      range: { from: start, to: end },
      rows: Object.values(
        details.reduce<Record<string, any>>((acc, detail) => {
          const key = detail.itemType;
          acc[key] ??= { itemType: key, quantity: 0, total: 0 };
          acc[key].quantity += Number(detail.quantity);
          acc[key].total += Number(detail.subtotal);
          acc[key].total = Number(acc[key].total.toFixed(2));
          return acc;
        }, {}),
      ),
    };
  }

  async productSales(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const details = await this.prisma.saleDetail.findMany({
      where: {
        itemType: SaleItemType.PRODUCT,
        sale: this.saleWhere(query, start, end, user),
      },
      include: { product: true },
    });

    return {
      range: { from: start, to: end },
      rows: Object.values(
        details.reduce<Record<string, any>>((acc, detail) => {
          const key = String(detail.productId);
          acc[key] ??= {
            productId: detail.productId,
            product: this.productTitle(detail.product),
            unit: detail.product?.unit ?? '-',
            quantity: 0,
            total: 0,
            costTotal: 0,
            profitTotal: 0,
            purchasePrice: Number(detail.product?.purchasePrice ?? 0),
            salePrice: Number(detail.product?.salePrice ?? 0),
            stock: detail.product?.stock ?? 0,
            minStock: detail.product?.minStock ?? 0,
          };
          const quantity = Number(detail.quantity);
          const subtotal = Number(detail.subtotal);
          const cost = Number(detail.product?.purchasePrice ?? 0) * quantity;
          acc[key].quantity += quantity;
          acc[key].total += subtotal;
          acc[key].costTotal += cost;
          acc[key].profitTotal += subtotal - cost;
          acc[key].total = Number(acc[key].total.toFixed(2));
          acc[key].costTotal = Number(acc[key].costTotal.toFixed(2));
          acc[key].profitTotal = Number(acc[key].profitTotal.toFixed(2));
          return acc;
        }, {}),
      ).sort((a: any, b: any) => b.total - a.total),
    };
  }

  async productSalesByUser(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const details = await this.prisma.saleDetail.findMany({
      where: {
        itemType: SaleItemType.PRODUCT,
        sale: this.saleWhere(query, start, end, user),
      },
      include: {
        product: true,
        sale: {
          include: {
            user: { include: { employee: true } },
            cashShift: { include: { openedBy: { include: { employee: true } } } },
          },
        },
      },
    });

    return {
      range: { from: start, to: end },
      rows: Object.values(
        details.reduce<Record<string, any>>((acc, detail) => {
          const userName =
            detail.sale.user.employee?.fullName ?? detail.sale.user.username;
          const cashUser =
            detail.sale.cashShift.openedBy.employee?.fullName ??
            detail.sale.cashShift.openedBy.username;
          const workShift = this.cashShiftWorkShift(detail.sale.cashShift.openedAt);
          const key = `${detail.productId}:${detail.sale.userId}:${detail.sale.cashShiftId}:${workShift}`;
          acc[key] ??= {
            productId: detail.productId,
            product: this.productTitle(detail.product),
            userId: detail.sale.userId,
            user: userName,
            cashShiftId: detail.sale.cashShiftId,
            cashShift: `Caja #${detail.sale.cashShiftId} - ${cashUser}`,
            cashOpenedAt: detail.sale.cashShift.openedAt,
            workShift,
            quantity: 0,
            total: 0,
          };
          acc[key].quantity += Number(detail.quantity);
          acc[key].total = Number(
            (acc[key].total + Number(detail.subtotal)).toFixed(2),
          );
          return acc;
        }, {}),
      ).sort((a: any, b: any) =>
        a.product === b.product
          ? String(a.cashShiftId).localeCompare(String(b.cashShiftId)) ||
            String(a.user).localeCompare(String(b.user))
          : String(a.product).localeCompare(String(b.product)),
      ),
    };
  }

  /**
   * Reporte unificado de ventas e ingresos.
   * Fusiona totales + desglose por tipo de ítem + anulaciones + ingresos por tipo de habitación.
   */
  async salesFull(query: ReportQueryDto, user?: AuthUser) {
    const { start, end } = this.range(query);
    const saleWhere = this.saleWhere(query, start, end, user);

    const [sales, details, cancelled] = await Promise.all([
      this.prisma.sale.findMany({
        where: saleWhere,
        include: {
          payments: true,
          customer: true,
          stay: { include: { room: true } },
          user: { include: { employee: true } },
          details: { include: { product: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.saleDetail.findMany({
        where: { sale: saleWhere },
        include: {
          sale: { select: { status: true } },
          product: true,
          stay: { include: { room: { include: { roomType: true } } } },
        },
      }),
      this.prisma.sale.findMany({
        where: { ...saleWhere, status: SaleStatus.CANCELLED },
        include: { user: { include: { employee: true } } },
        orderBy: { cancelledAt: 'desc' },
      }),
    ]);

    const payments = sales.flatMap((sale) => sale.payments);

    // Totales por estado.
    const byStatus = {
      PAID: this.sum(
        sales.filter((s) => s.status === SaleStatus.PAID).map((s) => Number(s.total)),
      ),
      OPEN: this.sum(
        sales.filter((s) => s.status === SaleStatus.OPEN).map((s) => Number(s.total)),
      ),
      CANCELLED: this.sum(
        sales.filter((s) => s.status === SaleStatus.CANCELLED).map((s) => Number(s.total)),
      ),
    };

    // Desglose por tipo de ítem (ROOM_RENT, PRODUCT, PENALTY, OTHER).
    const byItemType = Object.values(
      details.reduce<Record<string, any>>((acc, detail) => {
        const key = detail.itemType;
        acc[key] ??= { itemType: key, quantity: 0, total: 0 };
        acc[key].quantity += Number(detail.quantity);
        acc[key].total = Number((acc[key].total + Number(detail.subtotal)).toFixed(2));
        return acc;
      }, {}),
    );

    // Ingresos por tipo de habitación (solo ROOM_RENT, cruce con stay.room.roomType).
    const incomeByRoomType = Object.values(
      details
        .filter((detail) => detail.itemType === SaleItemType.ROOM_RENT && detail.stay)
        .reduce<Record<string, any>>((acc, detail) => {
          const roomTypeName = detail.stay?.room?.roomType?.name ?? 'Sin tipo';
          acc[roomTypeName] ??= { roomType: roomTypeName, count: 0, total: 0 };
          acc[roomTypeName].count += 1;
          acc[roomTypeName].total = Number(
            (acc[roomTypeName].total + Number(detail.subtotal)).toFixed(2),
          );
          return acc;
        }, {}),
    ).sort((a: any, b: any) => b.total - a.total);

    return {
      range: { from: start, to: end },
      summary: {
        count: sales.length,
        total: this.sum(sales.map((sale) => Number(sale.total))),
        paid: byStatus.PAID,
        pending: byStatus.OPEN,
        cancelled: this.sum(cancelled.map((sale) => Number(sale.total))),
      },
      byItemType,
      byPaymentMethod: this.groupSum(payments, 'paymentMethod', 'amount'),
      byStatus: this.groupSum(sales, 'status', 'total'),
      incomeByRoomType,
      cancellations: cancelled.map((sale) => ({
        id: sale.id,
        total: Number(sale.total),
        reason: sale.cancelReason,
        cancelledAt: sale.cancelledAt,
        cancelledBy:
          sale.user?.employee?.fullName ?? sale.user?.username ?? '-',
      })),
      sales: sales.map((sale) => ({
        id: sale.id,
        status: sale.status,
        customer: sale.customer?.fullName ?? 'Consumidor final',
        room: sale.stay?.room?.roomNumber ?? null,
        user: sale.user.employee?.fullName ?? sale.user.username,
        paymentMethod: sale.payments.map((payment) => payment.paymentMethod).join(' + ') || '-',
        total: Number(sale.total),
        createdAt: sale.createdAt,
        details: this.saleDetailsText(sale.details),
      })),
    };
  }

  async occupancy(query: ReportQueryDto) {
    const { start, end } = this.range(query);
    const [rooms, stays] = await Promise.all([
      this.prisma.room.findMany({
        where: { active: true },
        include: { roomType: true },
      }),
      this.prisma.stay.findMany({
        where: {
          checkIn: { lte: end },
          OR: [{ checkOut: null }, { checkOut: { gte: start } }],
        },
        include: { room: { include: { roomType: true } }, priceType: true },
      }),
    ]);
    const occupiedRoomIds = new Set(stays.map((stay) => stay.roomId));
    const closed = stays.filter((stay) => stay.checkOut);

    return {
      range: { from: start, to: end },
      totalRooms: rooms.length,
      occupiedRoomsInRange: occupiedRoomIds.size,
      occupancyPercent: rooms.length
        ? Number(((occupiedRoomIds.size / rooms.length) * 100).toFixed(2))
        : 0,
      activeStays: stays.filter((stay) => !stay.checkOut).length,
      closedStays: closed.length,
      averageHours: closed.length
        ? Number(
            (
              closed.reduce(
                (sum, stay) =>
                  sum +
                  ((stay.checkOut?.getTime() ?? 0) - stay.checkIn.getTime()) /
                    36e5,
                0,
              ) / closed.length
            ).toFixed(2),
          )
        : 0,
      byRoomType: this.countBy(stays, (stay: any) => stay.room.roomType.name),
      currentRoomStatus: this.countBy(rooms, (room: any) => room.status),
    };
  }

  async inventory(query: ReportQueryDto) {
    const { start, end } = this.range(query);
    const [products, movements] = await Promise.all([
      this.prisma.product.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.inventoryMovement.findMany({
        where: {
          createdAt: { gte: start, lte: end },
          ...(query.type ? { type: query.type } : {}),
        },
        include: { product: true, user: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const losses = movements.filter(
      (movement) => movement.type === InventoryMovementType.LOSS,
    );

    return {
      range: { from: start, to: end },
      lowStock: products
        .filter((product) => product.stock <= product.minStock)
        .map((product) => ({
          id: product.id,
          name: this.productTitle(product),
          stock: product.stock,
          minStock: product.minStock,
        })),
      movementsByType: this.countBy(movements, (movement: any) => movement.type),
      lossCount: losses.length,
      lossTotal: this.sum(
        losses.map(
          (loss) => Number(loss.quantity) * Number(loss.product.purchasePrice),
        ),
      ),
      movements: movements.map((movement) => ({
        id: movement.id,
        product: this.productTitle(movement.product),
        type: movement.type,
        quantity: movement.quantity,
        reason: movement.reason,
        createdAt: movement.createdAt,
      })),
    };
  }

  async staff(query: ReportQueryDto) {
    const { start, end } = this.range(query);
    const [payments, advances, discounts, pendingPenalties, attendances] =
      await Promise.all([
        this.prisma.staffPayment.findMany({
          where: { createdAt: { gte: start, lte: end } },
          include: { employee: true },
        }),
        this.prisma.staffAdvance.findMany({
          where: { createdAt: { gte: start, lte: end } },
          include: { employee: true },
        }),
        this.prisma.staffDiscount.findMany({
          where: { createdAt: { gte: start, lte: end } },
          include: { employee: true },
        }),
        // Penalidades pendientes (no dependen del rango: son el saldo actual).
        this.prisma.penalty.findMany({
          where: { status: 'PENDING' },
          include: { employee: true },
        }),
        // Asistencia del rango para cruce con pagos.
        this.prisma.attendance.findMany({
          where: { date: { gte: start, lte: end } },
          include: { employee: true },
        }),
      ]);

    // Penalidades pendientes sumadas por empleado.
    const pendingPenaltiesByEmployee = Object.values(
      pendingPenalties.reduce<Record<string, any>>((acc, penalty) => {
        const key = String(penalty.employeeId);
        acc[key] ??= {
          employeeId: penalty.employeeId,
          employee: penalty.employee.fullName,
          pendingPenalties: 0,
          count: 0,
        };
        acc[key].pendingPenalties = Number(
          (acc[key].pendingPenalties + Number(penalty.amount)).toFixed(2),
        );
        acc[key].count += 1;
        return acc;
      }, {}),
    );

    // Asistencia resumida por empleado en el rango.
    const attendanceSummaryByEmployee = Object.values(
      attendances.reduce<Record<string, any>>((acc, attendance) => {
        const key = String(attendance.employeeId);
        acc[key] ??= {
          employeeId: attendance.employeeId,
          employee: attendance.employee.fullName,
          days: 0,
          present: 0,
          late: 0,
          absent: 0,
        };
        acc[key].days += 1;
        if (attendance.status === 'PRESENT') acc[key].present += 1;
        else if (attendance.status === 'LATE') acc[key].late += 1;
        else if (attendance.status === 'ABSENT') acc[key].absent += 1;
        return acc;
      }, {}),
    );

    // Mapas auxiliares para enriquecer byEmployee.
    const pendingMap = new Map(
      pendingPenaltiesByEmployee.map((row: any) => [String(row.employeeId), row]),
    );
    const attendanceMap = new Map(
      attendanceSummaryByEmployee.map((row: any) => [String(row.employeeId), row]),
    );

    const byEmployee = Object.values(
      [...payments, ...advances, ...discounts].reduce<Record<string, any>>(
        (acc, row: any) => {
          const key = String(row.employeeId);
          acc[key] ??= {
            employeeId: row.employeeId,
            employee: row.employee.fullName,
            gross: 0,
            penaltiesApplied: 0,
            net: 0,
            advances: 0,
            discounts: 0,
            pendingPenalties: pendingMap.get(key)?.pendingPenalties ?? 0,
            attendanceDays: attendanceMap.get(key)?.days ?? 0,
          };
          if ('paidById' in row) {
            // StaffPayment: tiene grossAmount/penaltyAmount/amount.
            acc[key].gross += Number(row.grossAmount ?? row.amount);
            acc[key].penaltiesApplied += Number(row.penaltyAmount ?? 0);
            acc[key].net += Number(row.amount);
          } else if ('requestedById' in row) {
            acc[key].advances += Number(row.amount);
          } else {
            acc[key].discounts += Number(row.amount);
          }
          return acc;
        },
        {},
      ),
    );

    return {
      range: { from: start, to: end },
      paymentsTotal: this.sum(payments.map((row) => Number(row.amount))),
      paymentsGrossTotal: this.sum(
        payments.map((row) => Number(row.grossAmount ?? row.amount)),
      ),
      advancesTotal: this.sum(advances.map((row) => Number(row.amount))),
      discountsTotal: this.sum(discounts.map((row) => Number(row.amount))),
      penaltiesAppliedTotal: this.sum(
        payments.map((row) => Number(row.penaltyAmount ?? 0)),
      ),
      pendingPenaltiesTotal: this.sum(
        pendingPenaltiesByEmployee.map((row: any) => Number(row.pendingPenalties)),
      ),
      byEmployee,
      pendingPenaltiesByEmployee,
      attendanceSummaryByEmployee,
    };
  }

  async audit(query: ReportQueryDto) {
    const { start, end } = this.range(query);
    const logs = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      range: { from: start, to: end },
      count: logs.length,
      byAction: this.countBy(logs, (log: any) => log.action),
      byEntity: this.countBy(logs, (log: any) => log.entity),
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        user: log.user?.username ?? 'Sistema',
        createdAt: log.createdAt,
      })),
    };
  }

  private saleWhere(query: ReportQueryDto, start: Date, end: Date, user?: AuthUser) {
    return {
      createdAt: { gte: start, lte: end },
      ...(query.cashShiftId ? { cashShiftId: query.cashShiftId } : {}),
      ...(user?.role === UserRole.ADMIN && query.userId ? { userId: query.userId } : {}),
      ...this.saleOwnerWhere(user),
      ...(query.status
        ? { status: query.status }
        : { status: { not: SaleStatus.CANCELLED } }),
    };
  }

  private cashShiftOwnerWhere(user?: AuthUser) {
    return user?.role === UserRole.ADMIN ? {} : { openedById: this.userId(user) };
  }

  private saleOwnerWhere(user?: AuthUser) {
    return user?.role === UserRole.ADMIN ? {} : { userId: this.userId(user) };
  }

  private userId(user?: AuthUser) {
    const id = user?.sub ?? user?.id;
    if (!id) throw new ForbiddenException('Usuario no válido.');
    return id;
  }

  private range(query: ReportQueryDto) {
    const now = new Date();
    const start = query.from
      ? new Date(`${query.from}T00:00:00`)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = query.to ? new Date(`${query.to}T23:59:59.999`) : now;
    return { start, end };
  }

  private groupSum(rows: any[], key: string, amountKey: string) {
    return rows.reduce<Record<string, number>>((acc, row) => {
      const group = String(row[key] ?? 'UNKNOWN');
      acc[group] = Number(((acc[group] ?? 0) + Number(row[amountKey])).toFixed(2));
      return acc;
    }, {});
  }

  private countBy(rows: any[], key: (row: any) => string) {
    return rows.reduce<Record<string, number>>((acc, row) => {
      const group = key(row) ?? 'UNKNOWN';
      acc[group] = (acc[group] ?? 0) + 1;
      return acc;
    }, {});
  }

  private sum(values: number[]) {
    return Number(values.reduce((total, value) => total + Number(value), 0).toFixed(2));
  }

  private movementAmount(movement: any) {
    return Number(movement.salePayment?.amount ?? movement.amount);
  }

  private currentClosureTotals(closure: any) {
    const expectedByMethod = Object.fromEntries(
      Object.values(PaymentMethod).map((method) => {
        const movementTotal = this.sum(
          (closure.shift.cashMovements ?? [])
            .filter((movement: any) => movement.paymentMethod === method)
            .map((movement: any) =>
              movement.type === CashMovementType.INCOME
                ? this.movementAmount(movement)
                : -this.movementAmount(movement),
            ),
        );
        return [
          method,
          this.sum([
            movementTotal,
            method === PaymentMethod.CASH ? Number(closure.shift.openingAmount) : 0,
          ]),
        ];
      }),
    );
    const details = closure.details ?? [];
    const totalExpected = this.sum(
      details.map((detail: any) =>
        Number(expectedByMethod[detail.paymentMethod] ?? detail.expectedAmount),
      ),
    );
    const totalCounted = this.sum(details.map((detail: any) => Number(detail.countedAmount)));
    return {
      ...closure,
      totalExpected,
      totalCounted,
      difference: Number((totalCounted - totalExpected).toFixed(2)),
    };
  }

  private saleDetailsText(details: Array<{ quantity: any; description: string; subtotal: any }>) {
    return details
      .map((detail) => `${Number(detail.quantity)} x ${detail.description} (${Number(detail.subtotal).toFixed(2)})`)
      .join(', ');
  }

  private productTitle(product?: { name?: string | null; description?: string | null } | null) {
    const name = product?.name?.trim() || 'Producto';
    const description = product?.description?.trim();
    return description ? `${name} - ${description}` : name;
  }

  private cashShiftWorkShift(openedAt: Date) {
    const hour = openedAt.getHours();
    return hour >= 15 || hour < 6 ? 'Turno noche' : 'Turno día';
  }
}

type AuthUser = { sub?: number; id?: number; role: UserRole };
