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
import { CreatePriceTypeDto } from './dto/create-price-type.dto';
import { UpdatePriceTypeDto } from './dto/update-price-type.dto';
import { PriceTypesService } from './price-types.service';

@UseGuards(JwtAuthGuard)
@Controller('price-types')
export class PriceTypesController {
  constructor(private readonly priceTypesService: PriceTypesService) {}

  @Post()
  create(@Body() dto: CreatePriceTypeDto) {
    return this.priceTypesService.create(dto);
  }

  @Get()
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.priceTypesService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.priceTypesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePriceTypeDto,
  ) {
    return this.priceTypesService.update(id, dto);
  }

  @Patch(':id/toggle-active')
  toggleActive(@Param('id', ParseIntPipe) id: number) {
    return this.priceTypesService.toggleActive(id);
  }
}
