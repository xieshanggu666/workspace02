import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { User } from '../entities';
import { AuthGuard, JwtPayload } from './auth.guard';
import type { LoginRequest, LoginResponse, UserDto } from '@dialect/shared';

function toDto(u: User): UserDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    version: u.version,
    deviceId: u.deviceId,
    updatedAt: u.updatedAt,
    deletedAt: u.deletedAt ? new Date(u.deletedAt).toISOString() : null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginRequest): Promise<LoginResponse> {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.username = :name', { name: body.username })
      .getOne();
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.deletedAt) throw new UnauthorizedException('账号已停用');

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      deviceId: body.deviceId,
    };
    const token = await this.jwt.signAsync(payload);
    return { token, user: toDto(user) };
  }

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@Req() req: { user: JwtPayload }): Promise<LoginResponse['user']> {
    const user = await this.users.findOneBy({ id: req.user.sub });
    if (!user) throw new UnauthorizedException();
    return toDto(user);
  }
}
