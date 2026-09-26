import { IsUUID } from 'class-validator';

export class SwitchStoreDto {
  @IsUUID()
  tenantId: string;
}
