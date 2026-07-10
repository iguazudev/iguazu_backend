import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateProductDto) {
    const name = this.cleanName(dto.name);
    await this.ensureNameAvailable(name);
    return this.prisma.product.create({
      data: this.withNormalizedStock({ ...dto, name }),
    });
  }

  findAll() {
    return this.prisma.product.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Producto no encontrado.');
    return product;
  }

  async update(id: number, dto: UpdateProductDto) {
    const product = await this.findOne(id);
    const name = dto.name === undefined ? undefined : this.cleanName(dto.name);
    if (name !== undefined) await this.ensureNameAvailable(name, id);
    return this.prisma.product.update({
      where: { id },
      data: this.withNormalizedStock(
        { ...dto, name },
        dto.purchaseFactor ?? product.purchaseFactor,
      ),
    });
  }

  async toggleActive(id: number) {
    const product = await this.findOne(id);
    return this.prisma.product.update({
      where: { id },
      data: { active: !product.active },
    });
  }

  private cleanName(name: string) {
    const value = name.trim();
    if (!value) throw new BadRequestException('El nombre es requerido.');
    return value;
  }

  private async ensureNameAvailable(name: string, id?: number) {
    const exists = await this.prisma.product.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        NOT: id ? { id } : undefined,
      },
    });
    if (exists)
      throw new ConflictException('Ya existe un producto con ese nombre.');
  }

  private withNormalizedStock<T extends { stock?: number; purchaseFactor?: number }>(
    data: T,
    fallbackFactor = 1,
  ) {
    if (data.stock === undefined) return data;

    return {
      ...data,
      stock: data.stock * (data.purchaseFactor ?? fallbackFactor),
    };
  }
}
