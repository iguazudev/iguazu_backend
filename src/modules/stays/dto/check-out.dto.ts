import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Cobro del alojamiento en el check-out.
 *
 * `amount` es el monto total de alojamiento que debe estar cobrado al cerrar
 * la estadía (lo provee el frontend desde `accountByStay.lodging.amount`).
 *
 * El backend garantiza que el saldo (amount − ya cobrado en ventas ROOM_RENT
 * pagadas) quede cubierto por `payments` antes de liberar la habitación.
 */
export class CheckOutPaymentDto {
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}

export class CheckOutDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CheckOutPaymentDto)
  payments?: CheckOutPaymentDto[];
}
