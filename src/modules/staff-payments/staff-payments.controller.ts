import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateStaffPaymentDto } from './dto/create-staff-payment.dto';
import { StaffPaymentsService } from './staff-payments.service';

@UseGuards(JwtAuthGuard)
@Controller('staff-payments')
export class StaffPaymentsController {
  constructor(private readonly staffPaymentsService: StaffPaymentsService) {}

  @Post()
  create(@Body() dto: CreateStaffPaymentDto, @CurrentUser() user: any) {
    return this.staffPaymentsService.create(dto, user);
  }

  @Get()
  findAll() {
    return this.staffPaymentsService.findAll();
  }
}
