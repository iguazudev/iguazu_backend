import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateAttendanceDto } from './dto/create-attendance.dto';

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateAttendanceDto) {
    await this.ensureActiveEmployee(dto.employeeId);
    const date = new Date(dto.date);
    const exists = await this.prisma.attendance.findFirst({
      where: { employeeId: dto.employeeId, date, cashShiftId: null },
    });
    if (exists)
      throw new ConflictException('Ya existe asistencia para ese día.');
    return this.prisma.attendance.create({ data: { ...dto, date } });
  }

  async markCheckIn(id: number) {
    const attendance = await this.findOwned(id);
    if (attendance.checkIn) {
      throw new ConflictException('La entrada ya fue registrada.');
    }
    return this.prisma.attendance.update({
      where: { id },
      data: { checkIn: new Date() },
    });
  }

  async markCheckOut(id: number) {
    const attendance = await this.findOwned(id);
    if (!attendance.checkIn) {
      throw new BadRequestException('La entrada no fue registrada.');
    }
    if (attendance.checkOut) {
      throw new ConflictException('La salida ya fue registrada.');
    }
    return this.prisma.attendance.update({
      where: { id },
      data: { checkOut: new Date() },
    });
  }

  private async findOwned(id: number) {
    const attendance = await this.prisma.attendance.findUnique({
      where: { id },
    });
    if (!attendance) {
      throw new NotFoundException('Asistencia no encontrada.');
    }
    return attendance;
  }

  async byEmployee(employeeId: number, user: AuthUser) {
    await this.ensureCanSeeEmployee(employeeId, user);
    return this.prisma.attendance.findMany({
      where: { employeeId },
      orderBy: { date: 'desc' },
      include: this.include(),
    });
  }

  async byRange(from: string, to: string, user: AuthUser) {
    const employeeId =
      user.role === UserRole.ADMIN
        ? undefined
        : await this.employeeIdForUser(user.sub);
    return this.prisma.attendance.findMany({
      where: {
        date: { gte: new Date(from), lte: new Date(to) },
        ...(user.role === UserRole.ADMIN
          ? {}
          : employeeId
            ? { employeeId }
            : { id: -1 }),
      },
      orderBy: { date: 'desc' },
      include: this.include(),
    });
  }

  private async ensureActiveEmployee(id: number) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, active: true },
    });
    if (!employee)
      throw new NotFoundException('Empleado activo no encontrado.');
  }

  private include() {
    return {
      employee: true,
      cashShift: {
        include: {
          openedBy: { include: { employee: true } },
          closedBy: { include: { employee: true } },
        },
      },
    };
  }

  private async ensureCanSeeEmployee(employeeId: number, user: AuthUser) {
    if (user.role === UserRole.ADMIN) return;
    const ownEmployeeId = await this.employeeIdForUser(user.sub);
    if (ownEmployeeId !== employeeId) {
      throw new ForbiddenException('Solo puedes ver tus asistencias.');
    }
  }

  private async employeeIdForUser(userId: number) {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { employeeId: true },
    });
    return found?.employeeId ?? 0;
  }
}

type AuthUser = { sub: number; role: UserRole };
