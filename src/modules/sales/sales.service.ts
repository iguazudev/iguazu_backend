import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  CashShiftStatus,
  InvoiceStatus,
  InventoryMovementType,
  SaleItemType,
  SaleStatus,
  StayStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CancelSaleDto } from './dto/cancel-sale.dto';
import { CreateSaleDto, PaySaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';

const saleInclude = {
  customer: true,
  stay: { include: { room: true } },
  user: { include: { employee: true } },
  cashShift: true,
  details: { include: { product: true, stay: true } },
  payments: { include: { cashMovement: true } },
  invoice: { select: { id: true, docNumber: true, invoiceType: true, status: true, sunatCode: true } },
};

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateSaleDto, user: AuthUser) {
    if (!dto.details?.length)
      throw new BadRequestException('La venta requiere detalles.');
    const openShift = await this.openShiftFor(user, dto.cashShiftId);
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
    const payments = dto.payments ?? [];
    const isFreeSale = total === 0 && payments.length === 0;
    const isCharge = payments.length === 0 && !isFreeSale;
    if (isCharge && !dto.stayId) {
      throw new BadRequestException(
        'Para dejar un cargo pendiente selecciona una estadía.',
      );
    }
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
        if (quantity > 0) {
          await tx.product.update({
            where: { id: product.id },
            data: { stock: { decrement: quantity } },
          });
        }

        if (roomProduct && quantity > 0) {
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
          userId: user.sub,
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
        (item) => item.itemType === SaleItemType.PRODUCT && Number(item.quantity) > 0,
      )) {
        await tx.inventoryMovement.create({
          data: {
            productId: detail.productId!,
            type: InventoryMovementType.OUT,
            quantity: Number(detail.quantity),
            reason: `Venta #${sale.id}`,
            referenceType: 'SALE',
            referenceId: sale.id,
            userId: user.sub,
          },
        });
      }

      for (const payment of payments.filter((item) => item.amount > 0)) {
        const movement = await tx.cashMovement.create({
          data: {
            cashShiftId: openShift.id,
            userId: user.sub,
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

  async pay(id: number, dto: PaySaleDto, user: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (user.role !== UserRole.ADMIN && sale.userId !== user.sub) {
      throw new NotFoundException('Venta no encontrada.');
    }
    if (sale.status !== SaleStatus.OPEN) {
      throw new BadRequestException('El cargo no está pendiente.');
    }
    const paid = this.sum(dto.payments.map((payment) => payment.amount));
    if (paid !== Number(sale.total)) {
      throw new BadRequestException('El total y los pagos no coinciden.');
    }

    const openShift = await this.openShiftFor(user, dto.cashShiftId);

    return this.prisma.$transaction(async (tx) => {
      for (const payment of dto.payments.filter((item) => item.amount > 0)) {
        const movement = await tx.cashMovement.create({
          data: {
            cashShiftId: openShift.id,
            userId: user.sub,
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

  async cancel(id: number, dto: CancelSaleDto, user: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: { ...saleInclude, payments: { include: { cashMovement: true } } },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (user.role !== UserRole.ADMIN && sale.userId !== user.sub) {
      throw new NotFoundException('Venta no encontrada.');
    }
    if (sale.status === SaleStatus.CANCELLED) {
      throw new BadRequestException('La venta ya fue anulada.');
    }
    if (
      sale.invoice &&
      sale.invoice.status !== InvoiceStatus.CANCELED &&
      sale.invoice.status !== InvoiceStatus.REJECTED
    ) {
      throw new BadRequestException(
        'La venta tiene comprobante emitido. Primero emite la nota de crédito.',
      );
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
                userId: user.sub,
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
            cancelledById: user.sub,
          },
          include: saleInclude,
        });
      });
    }

    const openShift = await this.openShiftFor(user, dto.cashShiftId);

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
              userId: user.sub,
            },
          });
        }
      }

      // 2. Revertir caja: crear movimiento compensatorio por cada pago.
      for (const payment of sale.payments) {
        await tx.cashMovement.create({
          data: {
            cashShiftId: openShift.id,
            userId: user.sub,
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
          cancelledById: user.sub,
        },
        include: saleInclude,
      });
    });
  }

  async update(id: number, dto: UpdateSaleDto, user: AuthUser) {
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('El motivo es requerido.');
    if (!dto.details?.length) {
      throw new BadRequestException('La edición requiere detalles.');
    }

    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (sale.status === SaleStatus.CANCELLED) {
      throw new BadRequestException('No se puede editar una venta anulada.');
    }
    if (user.role !== UserRole.ADMIN && sale.userId !== user.sub) {
      throw new BadRequestException('Solo puedes editar tus ventas.');
    }
    if (user.role !== UserRole.ADMIN && (dto.userId !== undefined || dto.cashShiftId !== undefined)) {
      throw new BadRequestException('Solo ADMIN puede cambiar usuario o caja de una venta.');
    }
    if (
      sale.invoice &&
      (sale.invoice.status === InvoiceStatus.ACCEPTED ||
        sale.invoice.status === InvoiceStatus.OBSERVED)
    ) {
      throw new BadRequestException(
        'La venta tiene comprobante emitido. Corrige con nota de crédito/débito.',
      );
    }
    await this.validateSaleEditRelations(dto);
    const editedStay = dto.stayId
      ? await this.prisma.stay.findUnique({
          where: { id: dto.stayId },
          include: { room: true },
        })
      : null;
    const roomRentDescription = editedStay?.room?.roomNumber
      ? `Alojamiento Hab. ${editedStay.room.roomNumber}`
      : null;

    const detailsById = new Map(sale.details.map((detail) => [detail.id, detail]));
    const requestedIds = new Set(
      dto.details
        .map((detail) => detail.id)
        .filter((detailId): detailId is number => detailId !== undefined),
    );
    if (requestedIds.size !== dto.details.filter((detail) => detail.id !== undefined).length) {
      throw new BadRequestException('Hay detalles repetidos en la edición.');
    }
    for (const detail of dto.details) {
      if (detail.id !== undefined && !detailsById.has(detail.id)) {
        throw new BadRequestException('Uno o más detalles no pertenecen a la venta.');
      }
      if (detail.id === undefined && !detail.productId) {
        throw new BadRequestException('productId es requerido para agregar producto.');
      }
      if (detail.quantity !== undefined && !Number.isInteger(Number(detail.quantity))) {
        throw new BadRequestException('La cantidad de producto debe ser entera.');
      }
    }
    for (const detail of sale.details) {
      if (
        !requestedIds.has(detail.id) &&
        detail.itemType !== SaleItemType.PRODUCT
      ) {
        throw new BadRequestException('Solo se pueden quitar productos.');
      }
    }

    const newProductIds = dto.details
      .filter((detail) => detail.id === undefined)
      .map((detail) => detail.productId!)
      .filter((productId, index, list) => list.indexOf(productId) === index);
    const products = newProductIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: newProductIds }, active: true },
        })
      : [];
    if (products.length !== newProductIds.length) {
      throw new NotFoundException('Uno o más productos activos no existen.');
    }
    const productsById = new Map(products.map((product) => [product.id, product]));

    const nextDetails = dto.details.map((patch) => {
      if (patch.id !== undefined) {
        const detail = detailsById.get(patch.id)!;
        const isProduct = detail.itemType === SaleItemType.PRODUCT;
        const quantity = isProduct
          ? Number(patch.quantity ?? detail.quantity)
          : Number(detail.quantity);
        const unitPrice = patch.unitPrice ?? Number(detail.unitPrice);
        return {
          id: detail.id,
          itemType: detail.itemType,
          productId: detail.productId,
          stayId: detail.itemType === SaleItemType.ROOM_RENT ? (dto.stayId ?? detail.stayId) : detail.stayId,
          description:
            detail.itemType === SaleItemType.ROOM_RENT && roomRentDescription
              ? roomRentDescription
              : detail.description,
          quantity,
          unitPrice,
          subtotal: Number((quantity * unitPrice).toFixed(2)),
        };
      }

      const product = productsById.get(patch.productId!)!;
      const quantity = Number(patch.quantity ?? 1);
      const unitPrice = patch.unitPrice ?? Number(product.salePrice);
      return {
        itemType: SaleItemType.PRODUCT,
        productId: product.id,
        stayId: null,
        description: product.name,
        quantity,
        unitPrice,
        subtotal: Number((quantity * unitPrice).toFixed(2)),
      };
    });
    if (!nextDetails.length) {
      throw new BadRequestException('La venta debe conservar al menos un detalle.');
    }
    const total = this.sum(nextDetails.map((detail) => detail.subtotal));
    const oldTotal = Number(sale.total);
    const stockDeltas = this.productStockDeltas(sale.details, nextDetails);

    return this.prisma.$transaction(async (tx) => {
      for (const [productId, delta] of stockDeltas) {
        if (delta === 0) continue;
        if (delta > 0) {
          const product = await tx.product.findUnique({ where: { id: productId } });
          if (!product || product.stock < delta) {
            throw new BadRequestException('Stock insuficiente para editar la venta.');
          }
          await tx.product.update({
            where: { id: productId },
            data: { stock: { decrement: delta } },
          });
          await tx.inventoryMovement.create({
            data: {
              productId,
              type: InventoryMovementType.OUT,
              quantity: delta,
              reason: `Edición de venta #${id}`,
              referenceType: 'SALE_EDIT',
              referenceId: id,
              userId: user.sub,
            },
          });
        } else {
          await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: Math.abs(delta) } },
          });
          await tx.inventoryMovement.create({
            data: {
              productId,
              type: InventoryMovementType.IN,
              quantity: Math.abs(delta),
              reason: `Edición de venta #${id}`,
              referenceType: 'SALE_EDIT',
              referenceId: id,
              userId: user.sub,
            },
          });
        }
      }

      for (const detail of sale.details) {
        if (!nextDetails.some((next) => next.id === detail.id)) {
          await tx.saleDetail.delete({ where: { id: detail.id } });
        }
      }

      for (const detail of nextDetails) {
        if (detail.id === undefined) {
          await tx.saleDetail.create({
            data: {
              saleId: id,
              itemType: detail.itemType,
              productId: detail.productId,
              stayId: detail.stayId,
              description: detail.description,
              quantity: detail.quantity,
              unitPrice: detail.unitPrice,
              subtotal: detail.subtotal,
            },
          });
          continue;
        }

        await tx.saleDetail.update({
          where: { id: detail.id },
          data: {
            stayId: detail.stayId,
            description: detail.description,
            quantity: detail.quantity,
            unitPrice: detail.unitPrice,
            subtotal: detail.subtotal,
          },
        });
      }

      const paymentAdjustment = this.paymentAdjustment(sale, total);
      if (paymentAdjustment) {
        await tx.salePayment.update({
          where: { id: paymentAdjustment.paymentId },
          data: { amount: paymentAdjustment.amount },
        });
        if (paymentAdjustment.cashMovementId) {
          await tx.cashMovement.update({
            where: { id: paymentAdjustment.cashMovementId },
            data: { amount: paymentAdjustment.amount },
          });
        }
      }

      for (const payment of sale.payments) {
        if (!payment.cashMovementId) continue;
        await tx.cashMovement.update({
          where: { id: payment.cashMovementId },
          data: {
            amount:
              paymentAdjustment?.paymentId === payment.id
                ? paymentAdjustment.amount
                : Number(payment.amount),
          },
        });
      }

      const updated = await tx.sale.update({
        where: { id },
        data: {
          total,
          userId: dto.userId,
          cashShiftId: dto.cashShiftId,
          customerId: dto.customerId,
          stayId: dto.stayId,
        },
        include: saleInclude,
      });

      if (dto.paymentMethod || dto.cashShiftId || dto.userId) {
        for (const payment of sale.payments) {
          await tx.salePayment.update({
            where: { id: payment.id },
            data: { paymentMethod: dto.paymentMethod },
          });
          if (payment.cashMovementId) {
            await tx.cashMovement.update({
              where: { id: payment.cashMovementId },
              data: {
                paymentMethod: dto.paymentMethod,
                cashShiftId: dto.cashShiftId,
                userId: dto.userId,
              },
            });
          }
        }
      }

      await this.audit.log(
        {
          userId: user.sub,
          action: 'UPDATE',
          entity: 'Sale',
          entityId: id,
          oldData: {
            reason,
            total: oldTotal,
            status: sale.status,
            userId: sale.userId,
            cashShiftId: sale.cashShiftId,
            customerId: sale.customerId,
            stayId: sale.stayId,
            paymentMethods: sale.payments.map((payment) => payment.paymentMethod),
            details: sale.details.map((detail) => ({
              id: detail.id,
              itemType: detail.itemType,
              productId: detail.productId,
              description: detail.description,
              quantity: Number(detail.quantity),
              unitPrice: Number(detail.unitPrice),
              subtotal: Number(detail.subtotal),
            })),
          },
          newData: {
            reason,
            total,
            status: sale.status,
            userId: updated.userId,
            cashShiftId: updated.cashShiftId,
            customerId: updated.customerId,
            stayId: updated.stayId,
            paymentMethod: dto.paymentMethod,
            paymentAdjustment,
            stockDeltas: Object.fromEntries(stockDeltas),
            details: nextDetails,
          },
        },
        tx,
      );

      return updated;
    });
  }

  findAll(user: AuthUser) {
    return this.prisma.sale.findMany({
      where: user.role === UserRole.ADMIN ? undefined : { userId: user.sub },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async findOne(id: number, user: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (user.role !== UserRole.ADMIN && sale.userId !== user.sub) {
      throw new NotFoundException('Venta no encontrada.');
    }
    return sale;
  }

  byShift(cashShiftId: number, user: AuthUser) {
    return this.prisma.sale.findMany({
      where: {
        cashShiftId,
        ...(user.role === UserRole.ADMIN ? {} : { userId: user.sub }),
      },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  byStay(stayId: number, user: AuthUser) {
    return this.prisma.sale.findMany({
      where: {
        stayId,
        ...(user.role === UserRole.ADMIN ? {} : { userId: user.sub }),
      },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  pendingByStay(stayId: number, user: AuthUser) {
    return this.prisma.sale.findMany({
      where: {
        stayId,
        status: SaleStatus.OPEN,
        ...(user.role === UserRole.ADMIN ? {} : { userId: user.sub }),
      },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async accountByStay(stayId: number, user: AuthUser) {
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
          where: user.role === UserRole.ADMIN ? undefined : { userId: user.sub },
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

  private async validateSaleEditRelations(dto: UpdateSaleDto) {
    const checks: Promise<unknown>[] = [];
    if (dto.userId !== undefined) {
      checks.push(
        this.prisma.user.findFirst({ where: { id: dto.userId, active: true } }).then((row) => {
          if (!row) throw new NotFoundException('Usuario activo no encontrado.');
        }),
      );
    }
    if (dto.cashShiftId !== undefined) {
      checks.push(
        this.prisma.cashShift.findUnique({ where: { id: dto.cashShiftId } }).then((row) => {
          if (!row) throw new NotFoundException('Caja no encontrada.');
        }),
      );
    }
    if (dto.customerId !== undefined) {
      checks.push(
        this.prisma.customer.findUnique({ where: { id: dto.customerId } }).then((row) => {
          if (!row) throw new NotFoundException('Cliente no encontrado.');
        }),
      );
    }
    if (dto.stayId !== undefined) {
      checks.push(
        this.prisma.stay.findUnique({ where: { id: dto.stayId } }).then((row) => {
          if (!row) throw new NotFoundException('Estadía no encontrada.');
        }),
      );
    }
    await Promise.all(checks);
  }

  private validateDetail(detail: any) {
    if (detail.itemType === SaleItemType.PRODUCT && !detail.productId) {
      throw new BadRequestException('productId es requerido para PRODUCT.');
    }
    if (
      detail.itemType === SaleItemType.PRODUCT &&
      !Number.isInteger(Number(detail.quantity))
    ) {
      throw new BadRequestException(
        'La cantidad de producto debe ser entera.',
      );
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

  private productStockDeltas(
    oldDetails: Array<{
      itemType: SaleItemType;
      productId: number | null;
      quantity: any;
    }>,
    nextDetails: Array<{
      itemType: SaleItemType;
      productId?: number | null;
      quantity: number;
    }>,
  ) {
    const deltas = new Map<number, number>();
    for (const detail of oldDetails) {
      if (detail.itemType !== SaleItemType.PRODUCT || !detail.productId) continue;
      deltas.set(
        detail.productId,
        (deltas.get(detail.productId) ?? 0) - Number(detail.quantity),
      );
    }
    for (const detail of nextDetails) {
      if (detail.itemType !== SaleItemType.PRODUCT || !detail.productId) continue;
      deltas.set(
        detail.productId,
        (deltas.get(detail.productId) ?? 0) + Number(detail.quantity),
      );
    }
    return deltas;
  }

  private paymentAdjustment(
    sale: Awaited<ReturnType<typeof this.prisma.sale.findUnique>> & {
      payments: Array<{
        id: number;
        amount: any;
        cashMovementId: number | null;
      }>;
    },
    total: number,
  ) {
    if (sale.status !== SaleStatus.PAID) return null;

    const paid = this.sum(sale.payments.map((payment) => Number(payment.amount)));
    const delta = Number((total - paid).toFixed(2));
    if (delta === 0) return null;

    const payment = [...sale.payments].sort(
      (a, b) => Number(b.amount) - Number(a.amount),
    )[0];
    if (!payment) {
      throw new BadRequestException(
        'La venta pagada no tiene pagos para ajustar.',
      );
    }

    const amount = Number((Number(payment.amount) + delta).toFixed(2));
    if (amount < 0) {
      throw new BadRequestException(
        'El nuevo total no puede dejar un pago negativo. Anula la venta.',
      );
    }

    return {
      paymentId: payment.id,
      cashMovementId: payment.cashMovementId,
      amount,
      delta,
    };
  }
}

type AuthUser = { sub: number; role: UserRole };
