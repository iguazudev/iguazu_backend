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
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { StaysService } from './stays.service';

@UseGuards(JwtAuthGuard)
@Controller('stays')
export class StaysController {
  constructor(private readonly staysService: StaysService) {}

  @Post('check-in')
  checkIn(@Body() dto: CheckInDto, @CurrentUser() user: any) {
    return this.staysService.checkIn(dto, user);
  }

  @Patch(':id/check-out')
  checkOut(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CheckOutDto,
    @CurrentUser() user: any,
  ) {
    return this.staysService.checkOut(id, dto, user);
  }

  @Get('active')
  active() {
    return this.staysService.active();
  }

  @Get('history')
  history() {
    return this.staysService.history();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.staysService.findOne(id);
  }
}
