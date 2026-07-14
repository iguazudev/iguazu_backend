import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { PriceTypesModule } from './modules/price-types/price-types.module';
import { RoomTypesModule } from './modules/room-types/room-types.module';
import { RoomTypePricesModule } from './modules/room-type-prices/room-type-prices.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { CashShiftModule } from './modules/cash-shift/cash-shift.module';
import { CashMovementsModule } from './modules/cash-movements/cash-movements.module';
import { CustomersModule } from './modules/customers/customers.module';
import { StaysModule } from './modules/stays/stays.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { StaffAdvancesModule } from './modules/staff-advances/staff-advances.module';
import { StaffPaymentsModule } from './modules/staff-payments/staff-payments.module';
import { StaffDiscountsModule } from './modules/staff-discounts/staff-discounts.module';
import { PenaltiesModule } from './modules/penalties/penalties.module';
import { CashClosuresModule } from './modules/cash-closures/cash-closures.module';
import { AuditModule } from './modules/audit/audit.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { ReportsModule } from './modules/reports/reports.module';
import { BillingModule } from './modules/billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV
        ? [`.env.${process.env.NODE_ENV}.local`, `.env.${process.env.NODE_ENV}`, '.env']
        : ['.env'],
    }),
    AuthModule,
    UsersModule,
    EmployeesModule,
    PriceTypesModule,
    RoomTypesModule,
    RoomTypePricesModule,
    RoomsModule,
    CashShiftModule,
    CashMovementsModule,
    CustomersModule,
    StaysModule,
    ProductsModule,
    InventoryModule,
    SalesModule,
    ReservationsModule,
    AttendanceModule,
    StaffAdvancesModule,
    StaffPaymentsModule,
    StaffDiscountsModule,
    PenaltiesModule,
    CashClosuresModule,
    AuditModule,
    PermissionsModule,
    ReportsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
