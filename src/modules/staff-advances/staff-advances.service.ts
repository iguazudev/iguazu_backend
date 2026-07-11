import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  PenaltyStatus,
} from '@prisma/client';
import { CashMovementsService } from '../cash-movements/cash-movements.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateStaffAdvanceDto } from './dto/create-staff-advance.dto';

@Injectable()
export class StaffAdvancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashMovements: CashMovementsService,
  ) {}

  async create(dto: CreateStaffAdvanceDto, userId: number) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, active: true },
    });
    if (!employee)
      throw new NotFoundException('Empleado activo no encontrado.');

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.cashMovements.record(
        {
          userId,
          type: CashMovementType.EXPENSE,
          category: CashMovementCategory.STAFF_ADVANCE,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          description: dto.reason,
          referenceType: 'STAFF_ADVANCE',
        },
        tx,
      );
      const advance = await tx.staffAdvance.create({
        data: {
          employeeId: dto.employeeId,
          amount: dto.amount,
          reason: dto.reason,
          requestedById: userId,
          cashMovementId: movement.id,
        },
        include: { employee: true, cashMovement: true },
      });
      await tx.penalty.create({
        data: {
          employeeId: dto.employeeId,
          amount: dto.amount,
          reason: `Adelanto: ${dto.reason ?? 'sin detalle'}`,
          date: new Date(),
          status: PenaltyStatus.PENDING,
        },
      });
      await tx.cashMovement.update({
        where: { id: movement.id },
        data: { referenceId: advance.id },
      });
      return advance;
    });
  }

  findAll() {
    return this.prisma.staffAdvance.findMany({
      orderBy: { createdAt: 'desc' },
      include: { employee: true, cashMovement: true },
    });
  }
}
