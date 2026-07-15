import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreatePriceTypeDto } from './dto/create-price-type.dto';
import { UpdatePriceTypeDto } from './dto/update-price-type.dto';

@Injectable()
export class PriceTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePriceTypeDto) {
    const name = this.cleanName(dto.name);
    await this.ensureNameAvailable(name);

    return this.prisma.priceType.create({
      data: {
        name,
        description: dto.description,
      },
    });
  }

  async findAll(includeInactive = false) {
    return this.prisma.priceType.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: number) {
    return this.getPriceTypeOrThrow(id);
  }

  async update(id: number, dto: UpdatePriceTypeDto) {
    await this.getPriceTypeOrThrow(id);
    const name = dto.name === undefined ? undefined : this.cleanName(dto.name);

    if (name !== undefined) {
      await this.ensureNameAvailable(name, id);
    }

    return this.prisma.priceType.update({
      where: {
        id,
      },
      data: {
        ...dto,
        name,
      },
    });
  }

  async toggleActive(id: number) {
    const priceType = await this.getPriceTypeOrThrow(id);

    return this.prisma.priceType.update({
      where: {
        id,
      },
      data: {
        active: !priceType.active,
      },
    });
  }

  private async getPriceTypeOrThrow(id: number) {
    const priceType = await this.prisma.priceType.findUnique({
      where: {
        id,
      },
    });

    if (!priceType) {
      throw new NotFoundException('Tipo de tarifa no encontrado.');
    }

    return priceType;
  }

  private cleanName(name: string) {
    const value = name.trim();

    if (!value) {
      throw new BadRequestException('El nombre es requerido.');
    }

    return value;
  }

  private async ensureNameAvailable(name: string, id?: number) {
    const exists = await this.prisma.priceType.findFirst({
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
        'Ya existe un tipo de tarifa con ese nombre.',
      );
    }
  }
}
