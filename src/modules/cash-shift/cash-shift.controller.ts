import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CashShiftService } from './cash-shift.service';
import { CashShiftQueryDto } from './dto/cash-shift-query.dto';
import { OpenCashShiftDto } from './dto/create-cash-shift.dto';

@UseGuards(JwtAuthGuard)
@Controller('cash-shift')
export class CashShiftController {
  constructor(private readonly cashShiftService: CashShiftService) {}

  @Post('open')
  open(@Body() dto: OpenCashShiftDto, @CurrentUser() user: any) {
    return this.cashShiftService.open(dto, user.sub);
  }

  @Get('open')
  getOpenShift(@CurrentUser() user: any) {
    return this.cashShiftService.getOpenShift(user.sub);
  }

  @Get('open/all')
  getOpenShifts(@CurrentUser() user: any) {
    return this.cashShiftService.getOpenShifts(user);
  }

  @Post('close')
  close(@CurrentUser() user: any) {
    return this.cashShiftService.close(user.sub);
  }

  @Get('history')
  history(@Query() query: CashShiftQueryDto, @CurrentUser() user: any) {
    return this.cashShiftService.history(query, user);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cashShiftService.findOne(id, user);
  }
}
