import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReservationStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationCheckInDto } from './dto/reservation-check-in.dto';
import { ReservationsService } from './reservations.service';

@UseGuards(JwtAuthGuard)
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  create(@Body() dto: CreateReservationDto, @CurrentUser() user: any) {
    return this.reservationsService.create(dto, user);
  }

  @Get()
  findAll() {
    return this.reservationsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reservationsService.findOne(id);
  }

  @Patch(':id/confirm')
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.reservationsService.setStatus(id, ReservationStatus.CONFIRMED);
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.reservationsService.setStatus(id, ReservationStatus.CANCELLED);
  }

  @Patch(':id/no-show')
  noShow(@Param('id', ParseIntPipe) id: number) {
    return this.reservationsService.setStatus(id, ReservationStatus.NO_SHOW);
  }

  @Post(':id/check-in')
  checkIn(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReservationCheckInDto,
    @CurrentUser() user: any,
  ) {
    return this.reservationsService.checkIn(id, dto, user);
  }
}
