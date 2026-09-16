import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ACCOUNT_PATTERN, normalizeAccount } from '../account';

export class LoginDto {
  @Transform(({ value }: TransformFnParams) => {
    return normalizeAccount(value);
  })
  @IsString()
  @IsNotEmpty()
  @Matches(ACCOUNT_PATTERN, {
    message: '账号仅支持 3-64 位小写字母、数字、点、下划线或短横线',
  })
  account: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
