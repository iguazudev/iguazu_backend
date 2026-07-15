import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  PenaltyStatus,
  StaffAdvanceStatus,
  UserRole,
} from '@prisma/client';
import { CashMovementsService } from '../cash-movements/cash-movements.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateStaffAdvanceDto } from './dto/create-staff-advance.dto';
import { ReviewStaffAdvanceDto } from './dto/review-staff-advance.dto';

@Injectable()
export class StaffAdvancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashMovements: CashMovementsService,
  ) {}

  async create(dto: CreateStaffAdvanceDto, user: { sub: number; employeeId?: number | null }) {
    const employeeId = user.employeeId;
    if (!employeeId) {
      throw new BadRequestException('Tu usuario no está asociado a un empleado.');
    }
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, active: true },
    });
    if (!employee)
      throw new NotFoundException('Empleado activo no encontrado.');

    return this.prisma.staffAdvance.create({
      data: {
        employeeId,
        amount: dto.amount,
        reason: dto.reason,
        paymentMethod: dto.paymentMethod,
        requestedById: user.sub,
      },
      include: this.include,
    });
  }

  async approve(id: number, dto: ReviewStaffAdvanceDto, user: { sub: number; role: UserRole }) {
    const advance = await this.getPending(id);

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.cashMovements.record(
        {
          cashShiftId: dto.cashShiftId,
          userId: user.sub,
          actorRole: user.role,
          type: CashMovementType.EXPENSE,
          category: CashMovementCategory.STAFF_ADVANCE,
          amount: Number(advance.amount),
          paymentMethod: dto.paymentMethod ?? advance.paymentMethod,
          description: advance.reason ?? undefined,
          referenceType: 'STAFF_ADVANCE',
        },
        tx,
      );
      await tx.penalty.create({
        data: {
          employeeId: advance.employeeId,
          amount: advance.amount,
          reason: `Adelanto: ${advance.reason ?? 'sin detalle'}`,
          date: new Date(),
          status: PenaltyStatus.PENDING,
        },
      });
      const approved = await tx.staffAdvance.update({
        where: { id },
        data: {
          status: StaffAdvanceStatus.APPROVED,
          reviewedAt: new Date(),
          reviewNote: dto.note,
          cashMovementId: movement.id,
        },
        include: this.include,
      });
      await tx.cashMovement.update({
        where: { id: movement.id },
        data: { referenceId: id },
      });
      return approved;
    });
  }

  async reject(id: number, dto: ReviewStaffAdvanceDto) {
    await this.getPending(id);
    return this.prisma.staffAdvance.update({
      where: { id },
      data: {
        status: StaffAdvanceStatus.REJECTED,
        reviewedAt: new Date(),
        reviewNote: dto.note,
      },
      include: this.include,
    });
  }

  findAll(user: { sub: number; role: UserRole; employeeId?: number | null }) {
    return this.prisma.staffAdvance.findMany({
      where:
        user.role === UserRole.ADMIN
          ? undefined
          : {
              OR: [
                { requestedById: user.sub },
                ...(user.employeeId ? [{ employeeId: user.employeeId }] : []),
              ],
            },
      orderBy: { createdAt: 'desc' },
      include: this.include,
    });
  }

  private include = {
    employee: true,
    requestedBy: { include: { employee: true } },
    cashMovement: true,
  };

  private async getPending(id: number) {
    const advance = await this.prisma.staffAdvance.findUnique({
      where: { id },
      include: this.include,
    });
    if (!advance) throw new NotFoundException('Solicitud de adelanto no encontrada.');
    if (advance.status !== StaffAdvanceStatus.PENDING) {
      throw new BadRequestException('La solicitud ya fue revisada.');
    }
    return advance;
  }
}
