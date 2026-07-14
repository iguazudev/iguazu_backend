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
import { AttendanceService } from './attendance.service';
import { CreateAttendanceDto } from './dto/create-attendance.dto';

@UseGuards(JwtAuthGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post()
  create(@Body() dto: CreateAttendanceDto) {
    return this.attendanceService.create(dto);
  }

  @Patch(':id/check-in')
  markCheckIn(@Param('id', ParseIntPipe) id: number) {
    return this.attendanceService.markCheckIn(id);
  }

  @Patch(':id/check-out')
  markCheckOut(@Param('id', ParseIntPipe) id: number) {
    return this.attendanceService.markCheckOut(id);
  }

  @Get('employee/:employeeId')
  byEmployee(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @CurrentUser() user: any,
  ) {
    return this.attendanceService.byEmployee(employeeId, user);
  }

  @Get('range')
  byRange(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentUser() user: any,
  ) {
    return this.attendanceService.byRange(from, to, user);
  }
}
