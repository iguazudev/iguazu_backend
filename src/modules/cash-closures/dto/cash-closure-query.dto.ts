import { IsOptional, IsString } from 'class-validator';

export class CashClosureQueryDto {
  @IsString()
  @IsOptional()
  openedDate?: string;
}
