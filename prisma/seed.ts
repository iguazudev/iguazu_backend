/**
 * Seed inicial — Iguazú
 * Reinicia la data operativa y deja solo la base mínima.
 *
 * Uso:  npx prisma db seed
 *
 * Usuario administrador:
 *   username: process.env.SEED_ADMIN_USERNAME  (default: admin)
 *   password: process.env.SEED_ADMIN_PASSWORD  (default: Admin123!)
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient({
  adapter: new PrismaPg(process.env.DATABASE_URL!),
});

// Subset operativo de permisos para roles no-admin.
const RECEPTIONIST_PERMISSIONS = [
  'POST /cash-shift/open',
  'GET /cash-shift/open',
  'GET /customers',
  'GET /customers/:id',
  'GET /customers/by-document',
  'POST /customers',
  'PATCH /customers/:id',
  'GET /rooms',
  'GET /rooms/:id',
  'GET /room-types',
  'GET /price-types',
  'GET /room-type-prices',
  'GET /products',
  'POST /reservations',
  'GET /reservations',
  'GET /reservations/:id',
  'PATCH /reservations/:id/confirm',
  'PATCH /reservations/:id/cancel',
  'PATCH /reservations/:id/no-show',
  'POST /reservations/:id/check-in',
  'POST /stays/check-in',
  'PATCH /stays/:id/check-out',
  'GET /stays/active',
  'GET /stays/history',
  'GET /stays/:id',
  'POST /sales',
  'POST /sales/:id/pay',
  'GET /sales',
  'GET /sales/by-stay/:stayId',
  'GET /sales/pending/by-stay/:stayId',
  'GET /sales/account/by-stay/:stayId',
  'GET /sales/:id',
  'GET /cash-closures/preview',
  'GET /attendance/employee/:employeeId',
  'GET /attendance/range',
] as const;

const CASHIER_PERMISSIONS = [
  'POST /cash-shift/open',
  'GET /cash-shift/open',
  'POST /cash-closures/close',
  'GET /cash-closures/preview',
  'GET /cash-closures',
  'GET /cash-closures/:id',
  'GET /cash-movements',
  'GET /cash-movements/by-shift/:cashShiftId',
  'GET /cash-movements/:id',
  'POST /sales',
  'POST /sales/:id/pay',
  'GET /sales',
  'GET /sales/by-shift/:cashShiftId',
  'GET /sales/by-stay/:stayId',
  'GET /sales/pending/by-stay/:stayId',
  'GET /sales/account/by-stay/:stayId',
  'GET /sales/:id',
  'POST /inventory/in',
  'POST /inventory/out',
  'POST /inventory/loss',
  'POST /inventory/adjust',
  'GET /inventory/movements',
  'GET /products',
  'POST /staff-advances',
  'GET /staff-advances',
  'POST /staff-discounts',
  'GET /staff-discounts',
  'POST /staff-payments',
  'GET /staff-payments',
] as const;

async function main() {
  console.log('→ Seed Iguazú');
  await resetData();
  console.log('  ✓ Data operativa limpiada');

  // ----- 1. Usuario administrador -----
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn(
      '⚠  Usando password default para admin. Define SEED_ADMIN_PASSWORD en producción.',
    );
  }
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { username: adminUsername },
    update: { passwordHash, role: UserRole.ADMIN, active: true },
    create: {
      username: adminUsername,
      passwordHash,
      role: UserRole.ADMIN,
      active: true,
    },
  });
  console.log(`  ✓ Usuario admin: ${adminUsername}`);

  // ----- 2. Permisos por defecto para RECEPTIONIST y CASHIER -----
  await seedRolePermissions(UserRole.RECEPTIONIST, RECEPTIONIST_PERMISSIONS);
  await seedRolePermissions(UserRole.CASHIER, CASHIER_PERMISSIONS);
  console.log('  ✓ Permisos por rol (RECEPTIONIST, CASHIER)');

  console.log('✓ Seed completado.');
}

async function resetData() {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT format('%I.%I', schemaname, tablename) AS name
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  if (!tables.length) return;

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((table) => table.name).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function seedRolePermissions(
  role: UserRole,
  permissions: readonly string[],
) {
  await prisma.rolePermission.deleteMany({ where: { role } });
  if (permissions.length) {
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        role,
        permission,
        allowed: true,
      })),
      skipDuplicates: true,
    });
  }
}

main()
  .catch((error) => {
    console.error('✗ Seed falló:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
