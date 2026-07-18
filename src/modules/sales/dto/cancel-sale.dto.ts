import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CancelSaleDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsOptional()
  voidReason?: string;

}
