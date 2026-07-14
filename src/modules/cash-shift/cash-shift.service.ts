import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CashShiftStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenCashShiftDto } from './dto/create-cash-shift.dto';

@Injectable()
export class CashShiftService {
  constructor(private readonly prisma: PrismaService) {}

  async getOpenShift(userId: number) {
    return this.prisma.cashShift.findFirst({
      where: {
        status: CashShiftStatus.OPEN,
        openedById: userId,
      },
      include: {
        openedBy: {
          include: {
            employee: true,
          },
        },
        cashMovements: true,
      },
    });
  }

  async getOpenShifts(user: { sub: number; role: UserRole }) {
    return this.prisma.cashShift.findMany({
      where: {
        status: CashShiftStatus.OPEN,
        ...(user.role === UserRole.ADMIN ? {} : { openedById: user.sub }),
      },
      orderBy: { openedAt: 'desc' },
      include: {
        openedBy: { include: { employee: true } },
      },
    });
  }

  async open(dto: OpenCashShiftDto, userId: number) {
    const openShift = await this.getOpenShift(userId);

    if (openShift) {
      throw new ConflictException('Ya tienes una caja abierta.');
    }

    try {
      const cashShift = await this.prisma.cashShift.create({
        data: {
          openedById: userId,
          openingAmount: dto.openingAmount,
          status: CashShiftStatus.OPEN,
        },
        include: {
          openedBy: {
            include: {
              employee: true,
            },
          },
        },
      });

      if (cashShift.openedBy.employeeId) {
        await this.prisma.attendance.create({
          data: {
            employeeId: cashShift.openedBy.employeeId,
            cashShiftId: cashShift.id,
            date: this.dateOnly(cashShift.openedAt),
            checkIn: cashShift.openedAt,
            status: 'PRESENT',
            notes: `Caja #${cashShift.id}`,
          },
        });
      }

      await this.prisma.auditLog.create({
        data: {
          userId,
          action: 'CASH_OPEN',
          entity: 'CashShift',
          entityId: cashShift.id,
          newData: cashShift as any,
        },
      });

      return cashShift;
    } catch (error) {
      // P2002: violación de unique (índice parcial CashShift_openedById_status_OPEN_key).
      // Ocurre si dos requests de apertura colisionan (race condition).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya tienes una caja abierta.');
      }
      throw error;
    }
  }

  async close(userId: number) {
    void userId;
    throw new BadRequestException(
      'Cierra caja desde /cash-closures/close con arqueo.',
    );
  }

  async history() {
    return this.prisma.cashShift.findMany({
      orderBy: {
        openedAt: 'desc',
      },
      include: {
        openedBy: {
          include: {
            employee: true,
          },
        },
        closedBy: {
          include: {
            employee: true,
          },
        },
      },
    });
  }

  async findOne(id: number) {
    const cashShift = await this.prisma.cashShift.findUnique({
      where: {
        id,
      },
      include: {
        openedBy: {
          include: {
            employee: true,
          },
        },
        closedBy: {
          include: {
            employee: true,
          },
        },
        cashMovements: true,
        closure: true,
      },
    });

    if (!cashShift) {
      throw new NotFoundException('Caja no encontrada.');
    }

    return cashShift;
  }

  private dateOnly(value: Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
}
