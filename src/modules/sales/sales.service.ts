import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  InventoryMovementType,
  SaleItemType,
  SaleStatus,
  StayStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CancelSaleDto } from './dto/cancel-sale.dto';
import { CreateSaleDto, PaySaleDto } from './dto/create-sale.dto';

const saleInclude = {
  customer: true,
  stay: true,
  details: { include: { product: true, stay: true } },
  payments: { include: { cashMovement: true } },
  invoice: { select: { id: true, docNumber: true, invoiceType: true, status: true, sunatCode: true } },
};

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSaleDto, userId: number) {
    if (!dto.details?.length)
      throw new BadRequestException('La venta requiere detalles.');
    const payments = dto.payments ?? [];
    const isCharge = payments.length === 0;
    if (isCharge && !dto.stayId) {
      throw new BadRequestException(
        'Para dejar un cargo pendiente selecciona una estadía.',
      );
    }

    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: userId },
    });
    if (!openShift) throw new NotFoundException('No tienes caja abierta.');
    const stay = dto.stayId
      ? await this.prisma.stay.findFirst({
          where: { id: dto.stayId, status: StayStatus.ACTIVE },
        })
      : null;
    if (dto.stayId && !stay)
      throw new NotFoundException('Estadía activa no encontrada.');

    const details = dto.details.map((detail) => {
      this.validateDetail(detail);
      return {
        ...detail,
        subtotal: Number((detail.quantity * detail.unitPrice).toFixed(2)),
      };
    });
    const total = this.sum(details.map((detail) => detail.subtotal));
    const paid = this.sum(payments.map((payment) => payment.amount));
    if (!isCharge && total !== paid)
      throw new BadRequestException('El total y los pagos no coinciden.');

    return this.prisma.$transaction(async (tx) => {
      // Fase 1: validar TODO antes de mutar stock (evita descuentos parciales).
      type Product = NonNullable<Awaited<ReturnType<typeof tx.product.findUnique>>>;
      type RoomProduct = Awaited<ReturnType<typeof tx.roomProduct.findUnique>>;
      type ProductCheck = {
        product: Product;
        quantity: number;
        roomProduct: RoomProduct;
      };
      const productChecks: ProductCheck[] = [];
      await this.assertRoomRentNotRegistered(tx, details);

      for (const detail of details.filter(
        (item) => item.itemType === SaleItemType.PRODUCT,
      )) {
        const found = await tx.product.findUnique({
          where: { id: detail.productId },
        });
        if (!found || !found.active)
          throw new NotFoundException('Producto activo no encontrado.');

        const product: Product = found;
        const quantity = Number(detail.quantity);

        if (detail.source === 'ROOM' && !stay) {
          throw new BadRequestException(
            'El consumo de habitación requiere una estadía activa.',
          );
        }

        let roomProduct: RoomProduct = null;
        // Solo descuenta la bandeja de la habitación si el producto estaba asignado allí.
        if (detail.source === 'ROOM' && stay) {
          roomProduct = await tx.roomProduct.findUnique({
            where: {
              roomId_productId: {
                roomId: stay.roomId,
                productId: product.id,
              },
            },
          });
          if (!roomProduct || roomProduct.quantity < quantity) {
            throw new BadRequestException(
              `La habitación no tiene suficiente ${product.name}.`,
            );
          }
        }

        const nextStock = product.stock - quantity;
        if (nextStock < 0)
          throw new BadRequestException(
            `Stock insuficiente para ${product.name}.`,
          );

        productChecks.push({ product, quantity, roomProduct });
      }

      // Fase 2: aplicar los descuentos de stock (central y bandeja de habitación).
      for (const { product, quantity, roomProduct } of productChecks) {
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: quantity } },
        });

        if (roomProduct) {
          if (roomProduct.quantity === quantity) {
            await tx.roomProduct.delete({ where: { id: roomProduct.id } });
          } else {
            await tx.roomProduct.update({
              where: { id: roomProduct.id },
              data: { quantity: roomProduct.quantity - quantity },
            });
          }
        }
      }

      const sale = await tx.sale.create({
        data: {
          customerId: dto.customerId,
          stayId: dto.stayId,
          cashShiftId: openShift.id,
          userId,
          total,
          status: isCharge ? SaleStatus.OPEN : SaleStatus.PAID,
          invoiceType: dto.invoiceType ?? 'TICKET',
          invoiceNumber: dto.invoiceNumber,
          details: {
            create: details.map((detail) => ({
              itemType: detail.itemType,
              productId: detail.productId,
              stayId: detail.stayId,
              description: detail.description,
              quantity: detail.quantity,
              unitPrice: detail.unitPrice,
              subtotal: detail.subtotal,
            })),
          },
        },
      });

      for (const detail of details.filter(
        (item) => item.itemType === SaleItemType.PRODUCT,
      )) {
        await tx.inventoryMovement.create({
          data: {
            productId: detail.productId!,
            type: InventoryMovementType.OUT,
            quantity: Number(detail.quantity),
            reason: `Venta #${sale.id}`,
            referenceType: 'SALE',
            referenceId: sale.id,
            userId,
          },
        });
      }

      for (const payment of payments) {
        const movement = await tx.cashMovement.create({
          data: {
            cashShiftId: openShift.id,
            userId,
            type: CashMovementType.INCOME,
            category: this.saleCategory(details),
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            description: `Venta #${sale.id}`,
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

      return tx.sale.findUnique({
        where: { id: sale.id },
        include: saleInclude,
      });
    });
  }

  async pay(id: number, dto: PaySaleDto, userId: number) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (sale.status !== SaleStatus.OPEN) {
      throw new BadRequestException('El cargo no está pendiente.');
    }
    const paid = this.sum(dto.payments.map((payment) => payment.amount));
    if (paid !== Number(sale.total)) {
      throw new BadRequestException('El total y los pagos no coinciden.');
    }

    const openShift = await this.prisma.cashShift.findFirst({
      where: { status: CashShiftStatus.OPEN, openedById: userId },
    });
    if (!openShift) throw new NotFoundException('No tienes caja abierta.');

    return this.prisma.$transaction(async (tx) => {
      for (const payment of dto.payments) {
        const movement = await tx.cashMovement.create({
          data: {
            cashShiftId: openShift.id,
            userId,
            type: CashMovementType.INCOME,
            category: this.saleCategory(sale.details),
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            description: `Pago de cargo #${sale.id}`,
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

      return tx.sale.update({
        where: { id },
        data: { status: SaleStatus.PAID },
        include: saleInclude,
      });
    });
  }

  async cancel(id: number, dto: CancelSaleDto, userId: number) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: { ...saleInclude, payments: { include: { cashMovement: true } } },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (sale.status === SaleStatus.CANCELLED) {
      throw new BadRequestException('La venta ya fue anulada.');
    }

    // Si la venta estaba abierta (cargo pendiente sin cobro), solo marcar cancelada.
    if (sale.status === SaleStatus.OPEN) {
      return this.prisma.$transaction(async (tx) => {
        // Revertir stock de productos (si se descontó al crear el cargo).
        for (const detail of sale.details.filter(
          (d) => d.itemType === SaleItemType.PRODUCT,
        )) {
          if (detail.productId) {
            await tx.product.update({
              where: { id: detail.productId },
              data: { stock: { increment: Number(detail.quantity) } },
            });
            await tx.inventoryMovement.create({
              data: {
                productId: detail.productId,
                type: InventoryMovementType.IN,
                quantity: Number(detail.quantity),
                reason: `Anulación de cargo #${id}`,
                referenceType: 'SALE_VOID',
                referenceId: id,
                userId,
              },
            });
          }
        }

        return tx.sale.update({
          where: { id },
          data: {
            status: SaleStatus.CANCELLED,
            cancelReason: dto.voidReason ?? dto.reason,
            cancelledAt: new Date(),
            cancelledById: userId,
          },
          include: saleInclude,
        });
      });
    }

    // Venta PAGADA: revertir stock + crear movimientos de caja compensatorios.
    return this.prisma.$transaction(async (tx) => {
      // 1. Revertir stock de productos.
      for (const detail of sale.details.filter(
        (d) => d.itemType === SaleItemType.PRODUCT,
      )) {
        if (detail.productId) {
          await tx.product.update({
            where: { id: detail.productId },
            data: { stock: { increment: Number(detail.quantity) } },
          });
          await tx.inventoryMovement.create({
            data: {
              productId: detail.productId,
              type: InventoryMovementType.IN,
              quantity: Number(detail.quantity),
              reason: `Anulación de venta #${id}`,
              referenceType: 'SALE_VOID',
              referenceId: id,
              userId,
            },
          });
        }
      }

      // 2. Revertir caja: crear movimiento compensatorio por cada pago.
      for (const payment of sale.payments) {
        await tx.cashMovement.create({
          data: {
            cashShiftId: sale.cashShiftId,
            userId,
            type: CashMovementType.EXPENSE,
            category: payment.cashMovement?.category ?? CashMovementCategory.PRODUCT_SALE,
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            description: `Anulación venta #${id}`,
            referenceType: 'SALE_VOID',
            referenceId: id,
          },
        });
      }

      // 3. Marcar venta como anulada.
      return tx.sale.update({
        where: { id },
        data: {
          status: SaleStatus.CANCELLED,
          cancelReason: dto.voidReason ?? dto.reason,
          cancelledAt: new Date(),
          cancelledById: userId,
        },
        include: saleInclude,
      });
    });
  }

  findAll() {
    return this.prisma.sale.findMany({
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async findOne(id: number) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    return sale;
  }

  byShift(cashShiftId: number) {
    return this.prisma.sale.findMany({
      where: { cashShiftId },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  byStay(stayId: number) {
    return this.prisma.sale.findMany({
      where: { stayId },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  pendingByStay(stayId: number) {
    return this.prisma.sale.findMany({
      where: { stayId, status: SaleStatus.OPEN },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async accountByStay(stayId: number) {
    const stay = await this.prisma.stay.findUnique({
      where: { id: stayId },
      include: {
        customer: true,
        priceType: true,
        room: {
          include: {
            roomType: true,
            roomProducts: {
              include: { product: true },
              orderBy: { productId: 'asc' },
            },
          },
        },
        sales: {
          orderBy: { createdAt: 'desc' },
          include: saleInclude,
        },
      },
    });
    if (!stay) throw new NotFoundException('Estadía no encontrada.');

    const sales = stay.sales;
    const pendingCharges = sales.filter(
      (sale) => sale.status === SaleStatus.OPEN,
    );
    const paidCharges = sales.filter((sale) => sale.status === SaleStatus.PAID);
    const lodgingDetail = sales
      .flatMap((sale) =>
        sale.details.map((detail) => ({
          sale,
          detail,
        })),
      )
      .find(({ detail }) => detail.itemType === SaleItemType.ROOM_RENT);
    const lodgingStatus = lodgingDetail?.sale.status ?? 'UNBILLED';
    const lodgingAmount = lodgingDetail
      ? Number(lodgingDetail.detail.subtotal)
      : Number(stay.agreedPrice);
    const unbilledLodging = lodgingDetail ? 0 : Number(stay.agreedPrice);
    const pendingTotal = this.sum(
      pendingCharges.map((sale) => Number(sale.total)),
    );
    const paidTotal = this.sum(paidCharges.map((sale) => Number(sale.total)));

    return {
      stay,
      lodging: {
        amount: lodgingAmount,
        status: lodgingStatus,
        saleId: lodgingDetail?.sale.id ?? null,
        pendingAmount:
          lodgingStatus === SaleStatus.OPEN || lodgingStatus === 'UNBILLED'
            ? lodgingAmount
            : 0,
      },
      roomProducts: stay.room.roomProducts,
      pendingCharges,
      paidCharges,
      totals: {
        unbilledLodging,
        pendingCharges: pendingTotal,
        paidCharges: paidTotal,
        amountToCollect: this.sum([unbilledLodging, pendingTotal]),
        accountTotal: this.sum([unbilledLodging, pendingTotal, paidTotal]),
      },
    };
  }

  private validateDetail(detail: any) {
    if (detail.itemType === SaleItemType.PRODUCT && !detail.productId) {
      throw new BadRequestException('productId es requerido para PRODUCT.');
    }
    if (detail.itemType === SaleItemType.ROOM_RENT && !detail.stayId) {
      throw new BadRequestException('stayId es requerido para ROOM_RENT.');
    }
    if (
      (detail.itemType === SaleItemType.PENALTY ||
        detail.itemType === SaleItemType.OTHER) &&
      !detail.description?.trim()
    ) {
      throw new BadRequestException('La descripción es requerida.');
    }
  }

  private async assertRoomRentNotRegistered(
    db: any,
    details: Array<{ itemType: SaleItemType; stayId?: number }>,
  ) {
    const stayIds = details
      .filter((detail) => detail.itemType === SaleItemType.ROOM_RENT)
      .map((detail) => detail.stayId)
      .filter((stayId): stayId is number => typeof stayId === 'number');
    if (!stayIds.length) return;

    if (new Set(stayIds).size !== stayIds.length) {
      throw new BadRequestException(
        'El alojamiento solo puede registrarse una vez por estadía.',
      );
    }

    const existing = await db.saleDetail.findFirst({
      where: {
        itemType: SaleItemType.ROOM_RENT,
        stayId: { in: stayIds },
        sale: { status: { not: SaleStatus.CANCELLED } },
      },
      include: { sale: true },
    });
    if (existing) {
      throw new BadRequestException(
        `El alojamiento de la estadía #${existing.stayId} ya está registrado en la venta #${existing.saleId}.`,
      );
    }
  }

  /**
   * Clasifica una venta para el CashMovement:
   * - Solo productos -> PRODUCT_SALE
   * - Solo alojamiento -> ROOM_RENT
   * - Penalidades -> PRODUCT_LOSS_CHARGE
   * - Otros cargos -> CASH_ADJUSTMENT
   * - Mixta -> gana el tipo con mayor monto
   *
   * El reporte por tipo de ítem (salesByItemType) sigue siendo exacto porque
   * agrupa por SaleDetail; esta categoría solo ordena el arqueo de caja.
   */
  private saleCategory(
    details: Array<{ itemType: SaleItemType; subtotal?: number | { toNumber: () => number } }>,
  ) {
    const totals = {
      [CashMovementCategory.ROOM_RENT]: 0,
      [CashMovementCategory.PRODUCT_SALE]: 0,
      [CashMovementCategory.PRODUCT_LOSS_CHARGE]: 0,
      [CashMovementCategory.CASH_ADJUSTMENT]: 0,
    };

    for (const detail of details) {
      const amount = Number(detail.subtotal ?? 0);
      if (detail.itemType === SaleItemType.ROOM_RENT) {
        totals[CashMovementCategory.ROOM_RENT] += amount;
      } else if (detail.itemType === SaleItemType.PRODUCT) {
        totals[CashMovementCategory.PRODUCT_SALE] += amount;
      } else if (detail.itemType === SaleItemType.PENALTY) {
        totals[CashMovementCategory.PRODUCT_LOSS_CHARGE] += amount;
      } else {
        totals[CashMovementCategory.CASH_ADJUSTMENT] += amount;
      }
    }

    return Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0] as CashMovementCategory;
  }

  private sum(values: number[]) {
    return Number(
      values.reduce((total, value) => total + Number(value), 0).toFixed(2),
    );
  }
}
