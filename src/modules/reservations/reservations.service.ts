import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  PaymentMethod,
  ReservationStatus,
  UserRole,
} from '@prisma/client';
import { CashMovementsService } from '../cash-movements/cash-movements.service';
import { StaysService } from '../stays/stays.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationCheckInDto } from './dto/reservation-check-in.dto';

const reservationInclude = {
  customer: true,
  room: true,
  createdBy: true,
  stay: true,
};

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashMovements: CashMovementsService,
    private readonly stays: StaysService,
  ) {}

  async create(dto: CreateReservationDto, user: AuthUser) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (startDate >= endDate) {
      throw new BadRequestException('El rango de fechas no es válido.');
    }

    await this.ensureRoomAvailable(dto.roomId);
    await this.ensureNoOverlap(dto.roomId, startDate, endDate);

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.create({
        data: {
          customerId: dto.customerId,
          roomId: dto.roomId,
          startDate,
          endDate,
          depositAmount: dto.depositAmount,
          notes: dto.notes,
          createdById: user.sub,
        },
        include: reservationInclude,
      });

      if (dto.depositAmount && dto.depositAmount > 0) {
        await this.cashMovements.record(
          {
            cashShiftId: dto.cashShiftId,
            userId: user.sub,
            actorRole: user.role,
            type: CashMovementType.INCOME,
            category: CashMovementCategory.RESERVATION_DEPOSIT,
            amount: dto.depositAmount,
            paymentMethod: dto.paymentMethod ?? PaymentMethod.CASH,
            description: `Depósito reserva #${reservation.id}`,
            referenceType: 'RESERVATION',
            referenceId: reservation.id,
          },
          tx,
        );
      }

      return reservation;
    });
  }

  findAll() {
    return this.prisma.reservation.findMany({
      orderBy: { startDate: 'desc' },
      include: reservationInclude,
    });
  }

  async findOne(id: number) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: reservationInclude,
    });
    if (!reservation) throw new NotFoundException('Reserva no encontrada.');
    return reservation;
  }

  setStatus(id: number, status: ReservationStatus) {
    return this.prisma.reservation.update({
      where: { id },
      data: { status },
      include: reservationInclude,
    });
  }

  async checkIn(id: number, dto: ReservationCheckInDto, user: AuthUser) {
    const reservation = await this.findOne(id);
    if (
      reservation.status !== ReservationStatus.PENDING &&
      reservation.status !== ReservationStatus.CONFIRMED
    ) {
      throw new BadRequestException(
        'La reserva no está disponible para check-in.',
      );
    }

    return this.stays.checkIn(
      {
        ...dto,
        roomId: reservation.roomId,
        customerId: reservation.customerId,
        reservationId: reservation.id,
      },
      user,
    );
  }

  private async ensureRoomAvailable(roomId: number) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, active: true },
    });
    if (!room) throw new NotFoundException('Habitación activa no encontrada.');
  }

  private async ensureNoOverlap(
    roomId: number,
    startDate: Date,
    endDate: Date,
  ) {
    const overlap = await this.prisma.reservation.findFirst({
      where: {
        roomId,
        status: {
          in: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED],
        },
        startDate: { lt: endDate },
        endDate: { gt: startDate },
      },
    });
    if (overlap)
      throw new BadRequestException(
        'La habitación ya tiene reserva en ese rango.',
      );
  }
}

type AuthUser = { sub: number; role: UserRole };
