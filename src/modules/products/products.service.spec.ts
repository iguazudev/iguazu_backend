jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { ProductsService } from './products.service';

describe('ProductsService', () => {
  it('normalizes initial stock by purchase factor on create', async () => {
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };
    const service = new ProductsService(prisma as any);

    await service.create({
      name: 'prueba',
      purchasePrice: 150,
      salePrice: 10,
      stock: 10,
      minStock: 1,
      unit: 'CAJA',
      purchaseFactor: 20,
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ stock: 200 }),
    });
  });
});
