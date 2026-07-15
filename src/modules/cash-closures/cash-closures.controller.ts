import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CashClosuresService } from './cash-closures.service';
import { CloseCashShiftDto } from './dto/close-cash-shift.dto';
import { CashClosureQueryDto } from './dto/cash-closure-query.dto';
import { CorrectCashClosureDto } from './dto/correct-cash-closure.dto';
import { SettleDifferenceDto } from './dto/settle-difference.dto';

@UseGuards(JwtAuthGuard)
@Controller('cash-closures')
export class CashClosuresController {
  constructor(private readonly cashClosuresService: CashClosuresService) {}

  @Post('close')
  close(@Body() dto: CloseCashShiftDto, @CurrentUser() user: any) {
    return this.cashClosuresService.close(dto, user.sub);
  }

  @Get('preview')
  preview(@CurrentUser() user: any) {
    return this.cashClosuresService.preview(user.sub);
  }

  @Get()
  findAll(@Query() query: CashClosureQueryDto, @CurrentUser() user: any) {
    return this.cashClosuresService.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cashClosuresService.findOne(id, user);
  }

  @Post(':id/reopen')
  reopen(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.cashClosuresService.reopen(id, user);
  }

  @Patch(':id/counts')
  correctCounts(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CorrectCashClosureDto,
    @CurrentUser() user: any,
  ) {
    return this.cashClosuresService.correctCounts(id, dto, user);
  }

  @Post(':id/settle')
  settle(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SettleDifferenceDto,
    @CurrentUser() user: any,
  ) {
    return this.cashClosuresService.settleDifference(id, dto, user);
  }

  @Post(':id/sale-edits/:auditLogId/penalty')
  penalizeSaleEdit(
    @Param('id', ParseIntPipe) id: number,
    @Param('auditLogId', ParseIntPipe) auditLogId: number,
    @CurrentUser() user: any,
  ) {
    return this.cashClosuresService.penalizeSaleEdit(id, auditLogId, user);
  }

  @Post(':id/sale-edits/:auditLogId/loss')
  acceptSaleEditLoss(
    @Param('id', ParseIntPipe) id: number,
    @Param('auditLogId', ParseIntPipe) auditLogId: number,
    @CurrentUser() user: any,
  ) {
    return this.cashClosuresService.acceptSaleEdit(id, auditLogId, user);
  }
}
