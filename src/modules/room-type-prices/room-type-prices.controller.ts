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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateRoomTypePriceDto } from './dto/create-room-type-price.dto';
import { UpdateRoomTypePriceDto } from './dto/update-room-type-price.dto';
import { RoomTypePricesService } from './room-type-prices.service';

@UseGuards(JwtAuthGuard)
@Controller('room-type-prices')
export class RoomTypePricesController {
  constructor(private readonly roomTypePricesService: RoomTypePricesService) {}

  @Post()
  create(@Body() dto: CreateRoomTypePriceDto) {
    return this.roomTypePricesService.create(dto);
  }

  @Get()
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.roomTypePricesService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.roomTypePricesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoomTypePriceDto,
  ) {
    return this.roomTypePricesService.update(id, dto);
  }

  @Patch(':id/toggle-active')
  toggleActive(@Param('id', ParseIntPipe) id: number) {
    return this.roomTypePricesService.toggleActive(id);
  }
}
