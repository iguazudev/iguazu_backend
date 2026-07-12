import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  PaymentMethod,
  ReservationStatus,
  RoomStatus,
  SaleItemType,
  SaleStatus,
  StayStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';

const stayInclude = {
  customer: true,
  room: { include: { roomType: true } },
  priceType: true,
  reservation: true,
  cashShift: true,
  sales: {
    where: { status: SaleStatus.OPEN },
    include: {
      details: { include: { product: true } },
      payments: true,
    },
  },
};

@Injectable()
export class StaysService {
  constructor(private readonly prisma: PrismaService) {}

  async checkIn(dto: CheckInDto, user: AuthUser) {
    const openShift = await this.openShiftFor(user, dto.cashShiftId);

    const room = await this.prisma.room.findFirst({
      where: { id: dto.roomId, active: true },
    });
    if (!room) throw new NotFoundException('Habitación activa no encontrada.');
    if (room.status !== RoomStatus.AVAILABLE) {
      throw new BadRequestException('La habitación no está disponible.');
    }

    // Protección contra reservas: si este check-in NO viene de una reserva,
    // verificar que no haya una reserva activa (PENDING/CONFIRMED) cuyo rango
    // solape el DÍA de hoy (bloqueo por día completo, sin importar la hora).
    // Reservas para otros días (mañana o después) NO bloquean.
    // Si el check-in sí viene de una reserva, esa reserva misma se cierra al check-in.
    if (!dto.reservationId) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const conflict = await this.prisma.reservation.findFirst({
        where: {
          roomId: dto.roomId,
          status: { in: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED] },
          startDate: { lt: endOfDay },
          endDate: { gt: startOfDay },
        },
        include: { customer: true },
      });
      if (conflict) {
        const nombre = conflict.customer?.fullName ?? 'un cliente';
        throw new BadRequestException(
          `La habitación ${room.roomNumber} tiene reserva hoy para ${nombre}. Usá el check-in desde la reserva o asigná otra habitación.`,
        );
      }
    }

    const priceType = await this.prisma.priceType.findFirst({
      where: { id: dto.priceTypeId, active: true },
    });
    if (!priceType)
      throw new NotFoundException('Tipo de precio activo no encontrado.');

    const price = await this.prisma.roomTypePrice.findFirst({
      where: {
        roomTypeId: room.roomTypeId,
        priceTypeId: dto.priceTypeId,
        active: true,
      },
    });
    const agreedPrice = dto.agreedPrice ?? price?.amount;
    if (agreedPrice === undefined) {
      throw new NotFoundException(
        'Precio configurado no encontrado. Ingresa un precio pactado.',
      );
    }

    if (dto.customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
      });
      if (!customer) throw new NotFoundException('Cliente no encontrado.');
    }

    if (dto.expectedCheckOut) {
      const expected = new Date(dto.expectedCheckOut);
      if (expected.getTime() <= Date.now()) {
        throw new BadRequestException(
          'La fecha de salida esperada debe ser posterior al check-in.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const stay = await tx.stay.create({
        data: {
          customerId: dto.customerId,
          roomId: dto.roomId,
          reservationId: dto.reservationId,
          expectedCheckOut: dto.expectedCheckOut
            ? new Date(dto.expectedCheckOut)
            : undefined,
          priceTypeId: dto.priceTypeId,
          agreedPrice,
          status: StayStatus.ACTIVE,
          createdById: user.sub,
          cashShiftId: openShift.id,
        },
        include: stayInclude,
      });

      await tx.room.update({
        where: { id: dto.roomId },
        data: { status: RoomStatus.OCCUPIED },
      });

      if (dto.reservationId) {
        await tx.reservation.update({
          where: { id: dto.reservationId },
          data: { status: ReservationStatus.COMPLETED },
        });
      }

      return stay;
    });
  }

  async checkOut(id: number, dto: CheckOutDto, user: AuthUser) {
    const stay = await this.prisma.stay.findUnique({ where: { id } });
    if (!stay) throw new NotFoundException('Estadía no encontrada.');
    if (stay.status !== StayStatus.ACTIVE) {
      throw new BadRequestException('La estadía no está activa.');
    }
    const openCharges = await this.prisma.sale.count({
      where: { stayId: id, status: SaleStatus.OPEN },
    });
    if (openCharges) {
      throw new BadRequestException(
        'La estadía tiene cargos pendientes. Cóbralos antes del check-out.',
      );
    }

    // --- Garantía de cobro del alojamiento (Urgente 1) ---
    // Suma de ROOM_RENT ya cobrado en ventas pagadas de la estadía.
    const chargedRows = await this.prisma.saleDetail.aggregate({
      _sum: { subtotal: true },
      where: {
        itemType: SaleItemType.ROOM_RENT,
        stayId: id,
        sale: { status: SaleStatus.PAID },
      },
    });
    const alreadyCharged = Number(chargedRows._sum.subtotal ?? 0);
    const lodgingAmount = Number(stay.agreedPrice);
    const balance = Number((lodgingAmount - alreadyCharged).toFixed(2));

    const payments = dto.payments ?? [];
    if (balance > 0) {
      if (!payments.length) {
        throw new BadRequestException(
          `Falta cobrar el alojamiento: S/. ${balance.toFixed(2)}.`,
        );
      }
      const paid = this.sum(payments.map((p) => p.amount));
      if (paid !== balance) {
        throw new BadRequestException(
          `El pago del alojamiento (S/. ${paid.toFixed(2)}) no coincide con el saldo (S/. ${balance.toFixed(2)}).`,
        );
      }

      const openShift = await this.openShiftFor(user, dto.cashShiftId);
      stay.cashShiftId = openShift.id; // asegura consistencia de la tx abajo
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Si hay saldo de alojamiento, crear venta ROOM_RENT pagada y su caja.
      if (balance > 0) {
        const sale = await tx.sale.create({
          data: {
            customerId: stay.customerId,
            stayId: id,
            cashShiftId: stay.cashShiftId,
            userId: user.sub,
            total: balance,
            status: SaleStatus.PAID,
            invoiceType: 'TICKET',
            details: {
              create: {
                itemType: SaleItemType.ROOM_RENT,
                stayId: id,
                description: `Alojamiento estadía #${id}`,
                quantity: 1,
                unitPrice: balance,
                subtotal: balance,
              },
            },
          },
        });

        for (const payment of payments) {
          const movement = await tx.cashMovement.create({
            data: {
              cashShiftId: stay.cashShiftId,
              userId: user.sub,
              type: CashMovementType.INCOME,
              category: CashMovementCategory.ROOM_RENT,
              amount: payment.amount,
              paymentMethod: payment.paymentMethod,
              description: `Alojamiento estadía #${id}`,
              referenceType: 'SALE',
              referenceId: sale.id,
            },
          });
          await tx.salePayment.create({
            data: {
              saleId: sale.id,
              paymentMethod: payment.paymentMethod,
              amount: payment.amount,
              cashMovementId: movement.id,
            },
          });
        }
      }

      // 2. Cerrar la estadía y liberar la habitación.
      const closed = await tx.stay.update({
        where: { id },
        data: { status: StayStatus.CLOSED, checkOut: new Date() },
        include: stayInclude,
      });

      await tx.room.update({
        where: { id: stay.roomId },
        data: { status: RoomStatus.AVAILABLE },
      });

      return closed;
    });
  }

  active() {
    return this.prisma.stay.findMany({
      where: { status: StayStatus.ACTIVE },
      orderBy: { checkIn: 'desc' },
      include: stayInclude,
    });
  }

  history() {
    return this.prisma.stay.findMany({
      orderBy: { checkIn: 'desc' },
      include: stayInclude,
    });
  }

  async findOne(id: number) {
    const stay = await this.prisma.stay.findUnique({
      where: { id },
      include: stayInclude,
    });
    if (!stay) throw new NotFoundException('Estadía no encontrada.');
    return stay;
  }

  private async openShiftFor(user: AuthUser, cashShiftId?: number) {
    if (user.role === UserRole.ADMIN && !cashShiftId) {
      throw new BadRequestException('Selecciona una caja abierta.');
    }
    const openShift =
      user.role === UserRole.ADMIN && cashShiftId
        ? await this.prisma.cashShift.findFirst({
            where: { id: cashShiftId, status: CashShiftStatus.OPEN },
          })
        : await this.prisma.cashShift.findFirst({
            where: { status: CashShiftStatus.OPEN, openedById: user.sub },
          });
    if (!openShift) throw new NotFoundException('No tienes caja abierta.');
    return openShift;
  }

  private sum(values: number[]) {
    return Number(
      values.reduce((total, value) => total + Number(value), 0).toFixed(2),
    );
  }
}

type AuthUser = { sub: number; role: UserRole };
