import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportQueryDto } from './dto/report-query.dto';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('cash-summary')
  cashSummary(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.cashSummary(query, user);
  }

  @Get('sales-summary')
  salesSummary(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.salesSummary(query, user);
  }

  @Get('sales-full')
  salesFull(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.salesFull(query, user);
  }

  @Get('sales-by-item-type')
  salesByItemType(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.salesByItemType(query, user);
  }

  @Get('product-sales')
  productSales(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.productSales(query, user);
  }

  @Get('product-sales-by-user')
  productSalesByUser(@Query() query: ReportQueryDto, @CurrentUser() user: any) {
    return this.reportsService.productSalesByUser(query, user);
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
