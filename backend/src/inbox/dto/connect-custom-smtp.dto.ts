import { IsEmail, IsInt, IsOptional, IsString, IsIn, IsNotEmpty } from 'class-validator';

export class ConnectCustomSmtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  smtpHost: string;

  @IsInt()
  @IsIn([25, 465, 587])
  smtpPort: number;

  @IsString()
  @IsNotEmpty()
  smtpUser: string;

  @IsString()
  @IsNotEmpty()
  smtpPass: string;

  @IsString()
  @IsNotEmpty()
  imapHost: string;

  @IsInt()
  @IsIn([143, 993])
  imapPort: number;

  @IsString()
  @IsNotEmpty()
  imapUser: string;

  @IsString()
  @IsNotEmpty()
  imapPass: string;

  @IsString()
  @IsOptional()
  dkimSelector?: string;
}
