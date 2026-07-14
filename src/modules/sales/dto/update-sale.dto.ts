import { Type } from 'class-transformer';
import {
  IsArray,
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
  @Min(0.01)
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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateSaleDetailDto)
  details!: UpdateSaleDetailDto[];
}
