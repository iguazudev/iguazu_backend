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
  if (!Number.isInteger(saleId)) {
    throw new Error('Uso: node scripts/fix-sale-void-shift.js <saleId>');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error(`Venta #${saleId} no encontrada.`);

    const movements = await prisma.cashMovement.findMany({
      where: { referenceType: 'SALE_VOID', referenceId: saleId },
      select: { id: true, cashShiftId: true, amount: true },
      orderBy: { id: 'asc' },
    });
    const wrong = movements.filter((movement) => movement.cashShiftId !== sale.cashShiftId);
    if (!wrong.length) {
      console.log(`OK: anulacion de venta #${saleId} ya esta en caja #${sale.cashShiftId}.`);
      return;
    }

    await prisma.$transaction([
      prisma.cashMovement.updateMany({
        where: { id: { in: wrong.map((movement) => movement.id) } },
        data: { cashShiftId: sale.cashShiftId },
      }),
      prisma.auditLog.create({
        data: {
          action: 'DATA_FIX_SALE_VOID_SHIFT',
          entity: 'Sale',
          entityId: saleId,
          newData: {
            saleCashShiftId: sale.cashShiftId,
            movedCashMovementIds: wrong.map((movement) => movement.id),
          },
        },
      }),
    ]);

    console.log(
      `Listo: movi ${wrong.length} movimiento(s) de anulacion de venta #${saleId} a caja #${sale.cashShiftId}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
