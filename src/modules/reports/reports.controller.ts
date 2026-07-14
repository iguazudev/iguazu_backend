import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportQueryDto } from './dto/report-query.dto';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('cash-summary')
  cashSummary(@Query() query: ReportQueryDto) {
    return this.reportsService.cashSummary(query);
  }

  @Get('sales-summary')
  salesSummary(@Query() query: ReportQueryDto) {
    return this.reportsService.salesSummary(query);
  }

  @Get('sales-full')
  salesFull(@Query() query: ReportQueryDto) {
    return this.reportsService.salesFull(query);
  }

  @Get('sales-by-item-type')
  salesByItemType(@Query() query: ReportQueryDto) {
    return this.reportsService.salesByItemType(query);
  }

  @Get('product-sales')
  productSales(@Query() query: ReportQueryDto) {
    return this.reportsService.productSales(query);
  }

  @Get('product-sales-by-user')
  productSalesByUser(@Query() query: ReportQueryDto) {
    return this.reportsService.productSalesByUser(query);
  }

  @Get('occupancy')
  occupancy(@Query() query: ReportQueryDto) {
    return this.reportsService.occupancy(query);
  }

  @Get('inventory')
  inventory(@Query() query: ReportQueryDto) {
    return this.reportsService.inventory(query);
  }

  @Get('staff')
  staff(@Query() query: ReportQueryDto) {
    return this.reportsService.staff(query);
  }

  @Get('audit')
  audit(@Query() query: ReportQueryDto) {
    return this.reportsService.audit(query);
  }
}
