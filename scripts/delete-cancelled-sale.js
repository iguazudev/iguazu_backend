const fs = require('fs');
const path = require('path');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) throw new Error(`No encontre .env en ${envPath}`);
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  loadEnv();
  const saleId = Number(process.argv[2]);
  const confirmed = process.argv.includes('--confirm');
  if (!Number.isInteger(saleId)) {
    throw new Error('Uso: node scripts/delete-cancelled-sale.js <saleId> [--confirm]');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        invoice: true,
        details: true,
        payments: true,
      },
    });
    if (!sale) throw new Error(`Venta #${saleId} no encontrada.`);
    if (sale.status !== 'CANCELLED') {
      throw new Error(`Venta #${saleId} esta ${sale.status}; solo borro ventas anuladas.`);
    }
    if (sale.invoice) {
      throw new Error(`Venta #${saleId} tiene comprobante ${sale.invoice.docNumber}; no se borra por script.`);
    }

    const paymentMovementIds = sale.payments
      .map((payment) => payment.cashMovementId)
      .filter((id) => typeof id === 'number');
    const referencedMovements = await prisma.cashMovement.findMany({
      where: {
        OR: [
          { id: { in: paymentMovementIds } },
          { referenceType: { in: ['SALE', 'SALE_VOID'] }, referenceId: saleId },
        ],
      },
      select: { id: true, cashShiftId: true, type: true, amount: true, referenceType: true },
      orderBy: { id: 'asc' },
    });
    const inventoryMovements = await prisma.inventoryMovement.findMany({
      where: { referenceType: { in: ['SALE', 'SALE_VOID'] }, referenceId: saleId },
      select: { id: true, type: true, productId: true, quantity: true },
      orderBy: { id: 'asc' },
    });
    const cashMovementIds = referencedMovements.map((movement) => movement.id);

    console.log(JSON.stringify({
      sale: { id: sale.id, status: sale.status, cashShiftId: sale.cashShiftId, total: Number(sale.total) },
      saleDetails: sale.details.length,
      salePayments: sale.payments.length,
      cashMovements: referencedMovements.map((movement) => ({
        ...movement,
        amount: Number(movement.amount),
      })),
      inventoryMovements,
    }, null, 2));

    if (!confirmed) {
      console.log('\nVista previa. Para borrar realmente:');
      console.log(`node scripts/delete-cancelled-sale.js ${saleId} --confirm`);
      return;
    }

    await prisma.$transaction([
      prisma.auditLog.create({
        data: {
          action: 'DATA_FIX_DELETE_CANCELLED_SALE',
          entity: 'Sale',
          entityId: saleId,
          oldData: {
            sale: { ...sale, total: Number(sale.total) },
            cashMovementIds,
            inventoryMovementIds: inventoryMovements.map((movement) => movement.id),
          },
        },
      }),
      prisma.salePayment.deleteMany({ where: { saleId } }),
      prisma.saleDetail.deleteMany({ where: { saleId } }),
      prisma.cashMovement.deleteMany({ where: { id: { in: cashMovementIds } } }),
      prisma.inventoryMovement.deleteMany({
        where: { id: { in: inventoryMovements.map((movement) => movement.id) } },
      }),
      prisma.sale.delete({ where: { id: saleId } }),
    ]);

    console.log(`Listo: venta #${saleId} y sus movimientos fueron borrados.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
