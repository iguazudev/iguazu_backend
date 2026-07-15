import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoomStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomProductsDto } from './dto/update-room-products.dto';

const roomInclude = {
  roomType: {
    include: {
      prices: {
        where: {
          active: true,
        },
        include: {
          priceType: true,
        },
        orderBy: {
          priceTypeId: 'asc' as const,
        },
      },
    },
  },
  roomProducts: {
    include: {
      product: true,
    },
    orderBy: {
      productId: 'asc' as const,
    },
  },
};

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateRoomDto) {
    const roomNumber = this.cleanRoomNumber(dto.roomNumber);
    this.ensureCrudStatus(dto.status);
    await this.ensureRoomNumberAvailable(roomNumber);
    await this.ensureActiveRoomType(dto.roomTypeId);

    return this.prisma.room.create({
      data: {
        ...dto,
        roomNumber,
      },
      include: roomInclude,
    });
  }

  async findAll(includeInactive = false) {
    return this.prisma.room.findMany({
      where: includeInactive ? undefined : { active: true },
      include: roomInclude,
      orderBy: {
        roomNumber: 'asc',
      },
    });
  }

  async findOne(id: number) {
    return this.getRoomOrThrow(id);
  }

  async update(id: number, dto: UpdateRoomDto) {
    await this.getRoomOrThrow(id);
    const roomNumber =
      dto.roomNumber === undefined
        ? undefined
        : this.cleanRoomNumber(dto.roomNumber);

    this.ensureCrudStatus(dto.status);

    if (roomNumber !== undefined) {
      await this.ensureRoomNumberAvailable(roomNumber, id);
    }

    if (dto.roomTypeId !== undefined) {
      await this.ensureActiveRoomType(dto.roomTypeId);
    }

    return this.prisma.room.update({
      where: {
        id,
      },
      data: {
        ...dto,
        roomNumber,
      },
      include: roomInclude,
    });
  }

  async toggleActive(id: number) {
    const room = await this.getRoomOrThrow(id);

    return this.prisma.room.update({
      where: {
        id,
      },
      data: {
        active: !room.active,
      },
      include: roomInclude,
    });
  }

  async products(id: number) {
    await this.getRoomOrThrow(id);

    return this.prisma.roomProduct.findMany({
      where: {
        roomId: id,
      },
      include: {
        product: true,
      },
      orderBy: {
        productId: 'asc',
      },
    });
  }

  async updateProducts(id: number, dto: UpdateRoomProductsDto) {
    await this.getRoomOrThrow(id);

    const quantities = new Map<number, number>();
    for (const item of dto.products) {
      quantities.set(item.productId, item.quantity);
    }

    const productIds = [...quantities.keys()];
    if (productIds.length) {
      const count = await this.prisma.product.count({
        where: {
          id: {
            in: productIds,
          },
          active: true,
        },
      });

      if (count !== productIds.length) {
        throw new NotFoundException('Uno o más productos activos no existen.');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (productIds.length) {
        await tx.roomProduct.deleteMany({
          where: {
            roomId: id,
            productId: {
              notIn: productIds,
            },
          },
        });
      } else {
        await tx.roomProduct.deleteMany({
          where: {
            roomId: id,
          },
        });
      }

      // Cantidades de checklist por habitación (minibar/bandeja).
      // No trasladan stock del inventario central: representan lo que debería
      // haber físicamente. El consumo real se descuenta en sales.service (source=ROOM).
      for (const [productId, quantity] of quantities) {
        if (quantity <= 0) {
          await tx.roomProduct.deleteMany({
            where: {
              roomId: id,
              productId,
            },
          });
          continue;
        }

        await tx.roomProduct.upsert({
          where: {
            roomId_productId: {
              roomId: id,
              productId,
            },
          },
          create: {
            roomId: id,
            productId,
            quantity,
          },
          update: {
            quantity,
          },
        });
      }

      return tx.roomProduct.findMany({
        where: {
          roomId: id,
        },
        include: {
          product: true,
        },
        orderBy: {
          productId: 'asc',
        },
      });
    });
  }

  private async getRoomOrThrow(id: number) {
    const room = await this.prisma.room.findUnique({
      where: {
        id,
      },
      include: roomInclude,
    });

    if (!room) {
      throw new NotFoundException('Habitación no encontrada.');
    }

    return room;
  }

  private cleanRoomNumber(roomNumber: string) {
    const value = roomNumber.trim();

    if (!value) {
      throw new BadRequestException('El número de habitación es requerido.');
    }

    return value;
  }

  private ensureCrudStatus(status?: RoomStatus) {
    if (status === RoomStatus.OCCUPIED) {
      throw new BadRequestException(
        'El estado OCCUPIED se cambia desde el flujo de check-in.',
      );
    }
  }

  private async ensureRoomNumberAvailable(roomNumber: string, id?: number) {
    const exists = await this.prisma.room.findFirst({
      where: {
        roomNumber,
        NOT: id ? { id } : undefined,
      },
    });

    if (exists) {
      throw new ConflictException('Ya existe una habitación con ese número.');
    }
  }

  private async ensureActiveRoomType(id: number) {
    const roomType = await this.prisma.roomType.findFirst({
      where: {
        id,
        active: true,
      },
    });

    if (!roomType) {
      throw new NotFoundException('Tipo de habitación activo no encontrado.');
    }
  }
}
