import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAdminUserInput } from './dto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  listUsers() {
    return this.prisma.appUser.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async updateUser(id: string, currentUser: AppUser, patch: UpdateAdminUserInput): Promise<AppUser> {
    // Sinon le propriétaire pourrait se bloquer lui-même ou se retirer les
    // droits et perdre l'accès à l'administration.
    if (id === currentUser.id) throw new BadRequestException('Vous ne pouvez pas modifier votre propre compte');

    const existing = await this.prisma.appUser.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Compte introuvable');

    return this.prisma.appUser.update({ where: { id }, data: patch });
  }
}
