import { CashMovementCategory, PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateCashExpenseDto {
  @IsEnum(CashMovementCategory)
  category!: CashMovementCategory;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;
}
