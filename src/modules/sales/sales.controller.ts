import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CancelSaleDto } from './dto/cancel-sale.dto';
import { CreateSaleDto, PaySaleDto } from './dto/create-sale.dto';
import { SalesService } from './sales.service';

@UseGuards(JwtAuthGuard)
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: any) {
    return this.salesService.create(dto, user);
  }

  @Post(':id/pay')
  pay(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PaySaleDto,
    @CurrentUser() user: any,
  ) {
    return this.salesService.pay(id, dto, user);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelSaleDto,
    @CurrentUser() user: any,
  ) {
    return this.salesService.cancel(id, dto, user);
  }

  @Get()
  findAll() {
    return this.salesService.findAll();
  }

  @Get('by-shift/:cashShiftId')
  byShift(@Param('cashShiftId', ParseIntPipe) cashShiftId: number) {
    return this.salesService.byShift(cashShiftId);
  }

  @Get('by-stay/:stayId')
  byStay(@Param('stayId', ParseIntPipe) stayId: number) {
    return this.salesService.byStay(stayId);
  }

  @Get('pending/by-stay/:stayId')
  pendingByStay(@Param('stayId', ParseIntPipe) stayId: number) {
    return this.salesService.pendingByStay(stayId);
  }

  @Get('account/by-stay/:stayId')
  accountByStay(@Param('stayId', ParseIntPipe) stayId: number) {
    return this.salesService.accountByStay(stayId);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.salesService.findOne(id);
  }
}
