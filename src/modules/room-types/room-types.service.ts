import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomTypeDto } from './dto/create-room-type.dto';
import { UpdateRoomTypeDto } from './dto/update-room-type.dto';

const roomTypeInclude = {
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
};

@Injectable()
export class RoomTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateRoomTypeDto) {
    const name = this.cleanName(dto.name);
    await this.ensureNameAvailable(name);

    return this.prisma.roomType.create({
      data: {
        name,
        description: dto.description,
      },
    });
  }

  async findAll(includeInactive = false) {
    return this.prisma.roomType.findMany({
      where: includeInactive ? undefined : { active: true },
      include: roomTypeInclude,
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: number) {
    return this.getRoomTypeOrThrow(id);
  }

  async update(id: number, dto: UpdateRoomTypeDto) {
    await this.getRoomTypeOrThrow(id);
    const name = dto.name === undefined ? undefined : this.cleanName(dto.name);

    if (name !== undefined) {
      await this.ensureNameAvailable(name, id);
    }

    return this.prisma.roomType.update({
      where: {
        id,
      },
      data: {
        ...dto,
        name,
      },
      include: roomTypeInclude,
    });
  }

  async toggleActive(id: number) {
    const roomType = await this.getRoomTypeOrThrow(id);

    return this.prisma.roomType.update({
      where: {
        id,
      },
      data: {
        active: !roomType.active,
      },
      include: roomTypeInclude,
    });
  }

  private async getRoomTypeOrThrow(id: number) {
    const roomType = await this.prisma.roomType.findUnique({
      where: {
        id,
      },
      include: roomTypeInclude,
    });

    if (!roomType) {
      throw new NotFoundException('Tipo de habitación no encontrado.');
    }

    return roomType;
  }

  private cleanName(name: string) {
    const value = name.trim();

    if (!value) {
      throw new BadRequestException('El nombre es requerido.');
    }

    return value;
  }

  private async ensureNameAvailable(name: string, id?: number) {
    const exists = await this.prisma.roomType.findFirst({
      where: {
        name: {
          equals: name,
          mode: 'insensitive',
        },
        NOT: id ? { id } : undefined,
      },
    });

    if (exists) {
      throw new ConflictException(
        'Ya existe un tipo de habitación con ese nombre.',
      );
    }
  }
}
