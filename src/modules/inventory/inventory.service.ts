import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovementType, PenaltyStatus, UserRole } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  in(dto: CreateInventoryMovementDto, user: AuthUser) {
    return this.record(InventoryMovementType.IN, dto, user);
  }

  out(dto: CreateInventoryMovementDto, user: AuthUser) {
    return this.record(InventoryMovementType.OUT, dto, user);
  }

  loss(dto: CreateInventoryMovementDto, user: AuthUser) {
    return this.record(InventoryMovementType.LOSS, dto, user);
  }

  adjust(dto: CreateInventoryMovementDto, user: AuthUser) {
    // ADJUSTMENT usa quantity relativo: positivo suma stock, negativo resta.
    return this.record(InventoryMovementType.ADJUSTMENT, dto, user);
  }

  movements() {
    return this.prisma.inventoryMovement.findMany({
      orderBy: { createdAt: 'desc' },
      include: { product: true, user: true },
    });
  }

  movementsByProduct(productId: number) {
    return this.prisma.inventoryMovement.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });
  }

  record(
    type: InventoryMovementType,
    dto: CreateInventoryMovementDto,
    user: AuthUser,
    db: any = this.prisma,
  ) {
    return db.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: dto.productId },
      });
      if (!product || !product.active) {
        throw new NotFoundException('Producto activo no encontrado.');
      }

      // Si es ingreso (IN), la quantity del DTO representa paquetes/cajas.
      // Se multiplica por purchaseFactor para obtener unidades de stock.
      const stockDelta = this.normalizedQuantity(
        type,
        dto.quantity,
        type === InventoryMovementType.IN ? product.purchaseFactor : 1,
      );
      const nextStock = product.stock + stockDelta;
      if (nextStock < 0) throw new BadRequestException('Stock insuficiente.');

      await tx.product.update({
        where: { id: product.id },
        data: { stock: nextStock },
      });

      const movement = await tx.inventoryMovement.create({
        data: {
          productId: dto.productId,
          type,
          quantity: dto.quantity,
          reason: dto.reason,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          userId: user.sub,
        },
        include: { product: true, user: true },
      });

      const discountQuantity = Math.max(0, -stockDelta);
      if (user.employeeId && discountQuantity > 0) {
        await tx.penalty.create({
          data: {
            employeeId: user.employeeId,
            amount: Number(product.salePrice) * discountQuantity,
            reason: `Stock: ${product.name} x${discountQuantity}${
              dto.reason ? ` - ${dto.reason}` : ''
            }`,
            date: new Date(),
            status: PenaltyStatus.PENDING,
          },
        });
      }

      return movement;
    });
  }

  private normalizedQuantity(
    type: InventoryMovementType,
    quantity: number,
    purchaseFactor = 1,
  ) {
    if (type !== InventoryMovementType.ADJUSTMENT && quantity <= 0) {
      throw new BadRequestException('La cantidad debe ser mayor a cero.');
    }

    if (type === InventoryMovementType.IN) return quantity * purchaseFactor;
    if (type === InventoryMovementType.ADJUSTMENT) return quantity;
    return -quantity;
  }
}

type AuthUser = { sub: number; role: UserRole; employeeId?: number | null };
