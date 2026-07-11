import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementCategory,
  CashMovementType,
  InventoryMovementType,
  PaymentMethod,
  PenaltyStatus,
} from '@prisma/client';
import { CashMovementsService } from '../cash-movements/cash-movements.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateStaffDiscountDto } from './dto/create-staff-discount.dto';

@Injectable()
export class StaffDiscountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashMovements: CashMovementsService,
  ) {}

  async create(dto: CreateStaffDiscountDto, userId: number) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, active: true },
    });
    if (!employee)
      throw new NotFoundException('Empleado activo no encontrado.');

    return this.prisma.$transaction(async (tx) => {
      let inventoryMovementId = dto.inventoryMovementId;
      if (dto.productId && dto.quantity) {
        const product = await tx.product.findFirst({
          where: { id: dto.productId, active: true },
        });
        if (!product) throw new NotFoundException('Producto activo no encontrado.');
        if (product.stock < dto.quantity) {
          throw new BadRequestException('Stock insuficiente.');
        }
        await tx.product.update({
          where: { id: product.id },
          data: { stock: product.stock - dto.quantity },
        });
        const movement = await tx.inventoryMovement.create({
          data: {
            productId: product.id,
            type: InventoryMovementType.OUT,
            quantity: dto.quantity,
            reason: dto.reason,
            referenceType: 'STAFF_DISCOUNT',
            userId,
          },
        });
        inventoryMovementId = movement.id;
      }

      let cashMovementId: number | undefined;
      if (dto.chargeNow) {
        if (!dto.paymentMethod)
          throw new BadRequestException('paymentMethod es requerido.');
        const movement = await this.cashMovements.record(
          {
            userId,
            type: CashMovementType.INCOME,
            category: CashMovementCategory.PRODUCT_LOSS_CHARGE,
            amount: dto.amount,
            paymentMethod: dto.paymentMethod ?? PaymentMethod.CASH,
            description: dto.reason,
            referenceType: 'STAFF_DISCOUNT',
          },
          tx,
        );
        cashMovementId = movement.id;
      }

      const discount = await tx.staffDiscount.create({
        data: {
          employeeId: dto.employeeId,
          amount: dto.amount,
          reason: dto.reason,
          inventoryMovementId,
          stayId: dto.stayId,
          cashMovementId,
        },
        include: {
          employee: true,
          inventoryMovement: true,
          cashMovement: true,
        },
      });

      if (cashMovementId) {
        await tx.cashMovement.update({
          where: { id: cashMovementId },
          data: { referenceId: discount.id },
        });
      } else {
        await tx.penalty.create({
          data: {
            employeeId: dto.employeeId,
            amount: dto.amount,
            reason: `Descuento: ${dto.reason}`,
            date: new Date(),
            status: PenaltyStatus.PENDING,
          },
        });
      }

      return discount;
    });
  }

  findAll() {
    return this.prisma.staffDiscount.findMany({
      orderBy: { createdAt: 'desc' },
      include: { employee: true, inventoryMovement: true, cashMovement: true },
    });
  }
}
