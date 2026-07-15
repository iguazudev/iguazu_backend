import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomTypePriceDto } from './dto/create-room-type-price.dto';
import { UpdateRoomTypePriceDto } from './dto/update-room-type-price.dto';

const roomTypePriceInclude = {
  roomType: true,
  priceType: true,
};

@Injectable()
export class RoomTypePricesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateRoomTypePriceDto) {
    await this.ensureActiveRoomType(dto.roomTypeId);
    await this.ensureActivePriceType(dto.priceTypeId);
    await this.ensureCombinationAvailable(dto.roomTypeId, dto.priceTypeId);

    return this.prisma.roomTypePrice.create({
      data: dto,
      include: roomTypePriceInclude,
    });
  }

  async findAll(includeInactive = false) {
    return this.prisma.roomTypePrice.findMany({
      where: includeInactive ? undefined : { active: true },
      include: roomTypePriceInclude,
      orderBy: [
        {
          roomTypeId: 'asc',
        },
        {
          priceTypeId: 'asc',
        },
      ],
    });
  }

  async findOne(id: number) {
    return this.getRoomTypePriceOrThrow(id);
  }

  async update(id: number, dto: UpdateRoomTypePriceDto) {
    const roomTypePrice = await this.getRoomTypePriceOrThrow(id);
    const roomTypeId = dto.roomTypeId ?? roomTypePrice.roomTypeId;
    const priceTypeId = dto.priceTypeId ?? roomTypePrice.priceTypeId;

    if (dto.roomTypeId !== undefined) {
      await this.ensureActiveRoomType(dto.roomTypeId);
    }

    if (dto.priceTypeId !== undefined) {
      await this.ensureActivePriceType(dto.priceTypeId);
    }

    if (dto.roomTypeId !== undefined || dto.priceTypeId !== undefined) {
      await this.ensureCombinationAvailable(roomTypeId, priceTypeId, id);
    }

    return this.prisma.roomTypePrice.update({
      where: {
        id,
      },
      data: dto,
      include: roomTypePriceInclude,
    });
  }

  async toggleActive(id: number) {
    const roomTypePrice = await this.getRoomTypePriceOrThrow(id);

    return this.prisma.roomTypePrice.update({
      where: {
        id,
      },
      data: {
        active: !roomTypePrice.active,
      },
      include: roomTypePriceInclude,
    });
  }

  private async getRoomTypePriceOrThrow(id: number) {
    const roomTypePrice = await this.prisma.roomTypePrice.findUnique({
      where: {
        id,
      },
      include: roomTypePriceInclude,
    });

    if (!roomTypePrice) {
      throw new NotFoundException(
        'Precio de tipo de habitación no encontrado.',
      );
    }

    return roomTypePrice;
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

  private async ensureActivePriceType(id: number) {
    const priceType = await this.prisma.priceType.findFirst({
      where: {
        id,
        active: true,
      },
    });

    if (!priceType) {
      throw new NotFoundException('Tipo de tarifa activo no encontrado.');
    }
  }

  private async ensureCombinationAvailable(
    roomTypeId: number,
    priceTypeId: number,
    id?: number,
  ) {
    const exists = await this.prisma.roomTypePrice.findFirst({
      where: {
        roomTypeId,
        priceTypeId,
        NOT: id ? { id } : undefined,
      },
    });

    if (exists) {
      throw new ConflictException(
        'Ya existe un precio para ese tipo de habitación y tarifa.',
      );
    }
  }
}
