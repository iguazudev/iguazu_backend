import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CashShiftStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CashShiftQueryDto } from './dto/cash-shift-query.dto';
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

  async getOpenShifts(user: AuthUser) {
    return this.prisma.cashShift.findMany({
      where: {
        status: CashShiftStatus.OPEN,
        ...this.ownerWhere(user),
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

  async history(query: CashShiftQueryDto = {}, user?: AuthUser) {
    const where = query.openedDate
      ? {
          openedAt: {
            gte: new Date(`${query.openedDate}T00:00:00-05:00`),
            lte: new Date(`${query.openedDate}T23:59:59.999-05:00`),
          },
          ...this.ownerWhere(user),
        }
      : this.ownerWhere(user);
    const shifts = await this.prisma.cashShift.findMany({
      where,
      orderBy: {
        openedAt: 'desc',
      },
      take: query.openedDate ? undefined : 100,
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
    return query.openedDate
      ? shifts.filter((shift) => this.peruDateKey(shift.openedAt) === query.openedDate)
      : shifts;
  }

  async findOne(id: number, user?: AuthUser) {
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

    if (!cashShift || (user?.role !== UserRole.ADMIN && cashShift.openedById !== this.userId(user))) {
      throw new NotFoundException('Caja no encontrada.');
    }

    return cashShift;
  }

  private ownerWhere(user?: AuthUser) {
    return user?.role === UserRole.ADMIN ? {} : { openedById: this.userId(user) };
  }

  private userId(user?: AuthUser) {
    const id = user?.sub ?? user?.id;
    if (!id) throw new NotFoundException('Caja no encontrada.');
    return id;
  }

  private dateOnly(value: Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  private peruDateKey(value: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
}

type AuthUser = { sub?: number; id?: number; role: UserRole };
