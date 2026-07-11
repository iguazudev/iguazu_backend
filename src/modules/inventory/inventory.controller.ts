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
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { InventoryService } from './inventory.service';

@UseGuards(JwtAuthGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('in')
  in(@Body() dto: CreateInventoryMovementDto, @CurrentUser() user: any) {
    return this.inventoryService.in(dto, user);
  }

  @Post('out')
  out(@Body() dto: CreateInventoryMovementDto, @CurrentUser() user: any) {
    return this.inventoryService.out(dto, user);
  }

  @Post('loss')
  loss(@Body() dto: CreateInventoryMovementDto, @CurrentUser() user: any) {
    return this.inventoryService.loss(dto, user);
  }

  @Post('adjust')
  adjust(@Body() dto: CreateInventoryMovementDto, @CurrentUser() user: any) {
    return this.inventoryService.adjust(dto, user);
  }

  @Get('movements')
  movements() {
    return this.inventoryService.movements();
  }

  @Get('movements/product/:productId')
  movementsByProduct(@Param('productId', ParseIntPipe) productId: number) {
    return this.inventoryService.movementsByProduct(productId);
  }
}
