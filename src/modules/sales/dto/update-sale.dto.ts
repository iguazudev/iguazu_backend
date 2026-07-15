import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UpdateSaleDetailDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  id?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  productId?: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  quantity?: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  unitPrice?: number;
}

export class UpdateSaleDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  userId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  customerId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  stayId?: number;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateSaleDetailDto)
  details!: UpdateSaleDetailDto[];
}
