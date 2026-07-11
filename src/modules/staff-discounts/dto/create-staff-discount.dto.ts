import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateStaffDiscountDto {
  @Type(() => Number)
  @IsInt()
  employeeId!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  inventoryMovementId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  productId?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  stayId?: number;

  @IsBoolean()
  @IsOptional()
  chargeNow?: boolean;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;
}
