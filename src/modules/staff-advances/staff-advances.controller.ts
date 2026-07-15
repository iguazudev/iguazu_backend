import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateStaffAdvanceDto } from './dto/create-staff-advance.dto';
import { ReviewStaffAdvanceDto } from './dto/review-staff-advance.dto';
import { StaffAdvancesService } from './staff-advances.service';

@UseGuards(JwtAuthGuard)
@Controller('staff-advances')
export class StaffAdvancesController {
  constructor(private readonly staffAdvancesService: StaffAdvancesService) {}

  @Post()
  create(@Body() dto: CreateStaffAdvanceDto, @CurrentUser() user: any) {
    return this.staffAdvancesService.create(dto, user);
  }

  @Post(':id/approve')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewStaffAdvanceDto,
    @CurrentUser() user: any,
  ) {
    return this.staffAdvancesService.approve(id, dto, user);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewStaffAdvanceDto,
  ) {
    return this.staffAdvancesService.reject(id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.staffAdvancesService.findAll(user);
  }
}
