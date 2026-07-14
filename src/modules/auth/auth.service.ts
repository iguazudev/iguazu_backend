import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: {
        username: dto.username,
      },
      include: {
        employee: true,
      },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    }

    const validPassword = await bcrypt.compare(dto.password, user.passwordHash);

    if (!validPassword) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    }

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      employeeId: user.employeeId,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        employee: user.employee,
        permissions: await this.permissionsForRole(user.role),
      },
    };
  }

  async me(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        employee: true,
      },
    });

    if (!user) return null;

    return {
      ...user,
      permissions: await this.permissionsForRole(user.role),
    };
  }

  private async permissionsForRole(role: UserRole) {
    if (role === UserRole.ADMIN) return ['*'];

    const rows = await this.prisma.rolePermission.findMany({
      where: { role, allowed: true },
      orderBy: { permission: 'asc' },
    });

    return rows.map((row) => row.permission);
  }
}
