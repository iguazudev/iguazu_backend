import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuditModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
