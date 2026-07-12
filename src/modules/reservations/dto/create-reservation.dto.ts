import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateReservationDto {
  @Type(() => Number)
  @IsInt()
  customerId!: number;

  @Type(() => Number)
  @IsInt()
  roomId!: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  depositAmount?: number;

  // Método de pago del depósito. Default CASH si hay depósito.
  @IsEnum(PaymentMethod)
  @IsOptional()
  @ValidateIf((o) => o.depositAmount && o.depositAmount > 0)
  paymentMethod?: PaymentMethod;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @IsString()
  @IsOptional()
  notes?: string;
}
