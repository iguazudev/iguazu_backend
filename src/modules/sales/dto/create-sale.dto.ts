import { PaymentMethod, SaleItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateSaleDetailDto {
  @IsEnum(SaleItemType)
  itemType!: SaleItemType;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  productId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  stayId?: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsIn(['ROOM', 'STORE'])
  @IsOptional()
  source?: 'ROOM' | 'STORE';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  quantity!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
}

export class CreateSalePaymentDto {
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;
}

export class CreateSaleDto {
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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSaleDetailDto)
  details!: CreateSaleDetailDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateSalePaymentDto)
  payments?: CreateSalePaymentDto[];

  @IsString()
  @IsOptional()
  @IsIn(['TICKET', 'BOLETA', 'FACTURA'])
  invoiceType?: string;

  @IsString()
  @IsOptional()
  invoiceNumber?: string;
}

export class PaySaleDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalePaymentDto)
  payments!: CreateSalePaymentDto[];
}
