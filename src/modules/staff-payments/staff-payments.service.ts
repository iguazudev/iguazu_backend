import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  PenaltyStatus,
  UserRole,
} from '@prisma/client';
import { CashMovementsService } from '../cash-movements/cash-movements.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateStaffPaymentDto } from './dto/create-staff-payment.dto';

@Injectable()
export class StaffPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashMovements: CashMovementsService,
  ) {}

  async create(
    dto: CreateStaffPaymentDto,
    user: { sub: number; role: UserRole },
  ) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, active: true },
    });
    if (!employee) {
      throw new NotFoundException('Empleado activo no encontrado.');
    }

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (periodStart > periodEnd) {
      throw new BadRequestException('Rango inválido.');
    }
    const existingPayment = await this.prisma.staffPayment.findFirst({
      where: {
        employeeId: dto.employeeId,
        periodStart: { lte: periodEnd },
        periodEnd: { gte: periodStart },
      },
    });
    if (existingPayment) {
      throw new BadRequestException(
        'El empleado ya tiene un pago registrado en ese período.',
      );
    }

    // Asistencia: conteo referencial para sugerir el bruto. No crea FK.
    const attendanceCount = await this.prisma.attendance.count({
      where: {
        employeeId: dto.employeeId,
        date: { gte: periodStart, lte: periodEnd },
      },
    });

    const grossAmount =
      dto.amount ??
      Number(
        (Number(employee.dailyRate ?? 0) * attendanceCount).toFixed(2),
      );
    if (grossAmount <= 0) {
      throw new BadRequestException('El monto bruto debe ser mayor a cero.');
    }

    const selectedPenaltyIds = dto.penaltyIds
      ? [...new Set(dto.penaltyIds)]
      : undefined;

    const penalties = await this.prisma.penalty.findMany({
      where: {
        employeeId: dto.employeeId,
        status: PenaltyStatus.PENDING,
        date: { lte: periodEnd },
        ...(selectedPenaltyIds ? { id: { in: selectedPenaltyIds } } : {}),
      },
      orderBy: { date: 'asc' },
    });
    if (selectedPenaltyIds && penalties.length !== selectedPenaltyIds.length) {
      throw new BadRequestException(
        'Hay descuentos seleccionados que no están pendientes para este empleado.',
      );
    }
    const penaltyAmount = Number(
      penalties
        .reduce((sum, p) => sum + Number(p.amount), 0)
        .toFixed(2),
    );
    const netAmount = Number((grossAmount - penaltyAmount).toFixed(2));
    if (netAmount <= 0) {
      throw new BadRequestException(
        'El neto a pagar debe ser mayor a cero. Desmarca algún descuento.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Movimiento de caja por el neto (lo que efectivamente sale de caja).
      const movement = await this.cashMovements.record(
        {
          cashShiftId: dto.cashShiftId,
          userId: user.sub,
          actorRole: user.role,
          type: CashMovementType.EXPENSE,
          category: CashMovementCategory.STAFF_PAYMENT,
          amount: netAmount,
          paymentMethod: dto.paymentMethod,
          description: `Pago personal ${employee.fullName}`,
          referenceType: 'STAFF_PAYMENT',
        },
        tx,
      );

      // 2. Crear el pago con snapshot bruto/penalidad/neto.
      const payment = await tx.staffPayment.create({
        data: {
          employeeId: dto.employeeId,
          grossAmount,
          penaltyAmount,
          amount: netAmount,
          periodStart,
          periodEnd,
          cashMovementId: movement.id,
          paidById: user.sub,
        },
        include: { employee: true, cashMovement: true },
      });

      // 3. Vincular penalidades aplicadas (snapshot del monto) y marcarlas.
      if (penalties.length) {
        await tx.staffPaymentPenalty.createMany({
          data: penalties.map((penalty) => ({
            staffPaymentId: payment.id,
            penaltyId: penalty.id,
            amount: penalty.amount,
          })),
        });
        await tx.penalty.updateMany({
          where: { id: { in: penalties.map((p) => p.id) } },
          data: { status: PenaltyStatus.APPLIED },
        });
      }

      // 4. Cerrar la referencia del movimiento de caja.
      await tx.cashMovement.update({
        where: { id: movement.id },
        data: { referenceId: payment.id },
      });

      return {
        ...payment,
        penaltiesApplied: penalties.length,
        attendanceCount,
      };
    });
  }

  findAll() {
    return this.prisma.staffPayment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        employee: true,
        cashMovement: true,
        penalties: { include: { penalty: true } },
      },
    });
  }
}
