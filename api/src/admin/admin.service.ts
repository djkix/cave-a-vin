import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { adminEmailsFromEnv } from '../auth/admin-emails';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAdminUserInput } from './dto';

// Jamais password_hash (argon2 du compte de secours) ni google_sub dans une
// réponse à un administrateur : ni l'un ni l'autre ne doivent voyager vers un
// navigateur, un journal de proxy ou un cache.
const SAFE_SELECT = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  isAdmin: true,
  isBreakGlass: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  listUsers() {
    return this.prisma.appUser.findMany({ orderBy: { createdAt: 'desc' }, select: SAFE_SELECT });
  }

  async updateUser(id: string, currentUser: AppUser, patch: UpdateAdminUserInput) {
    // Sinon le propriétaire pourrait se bloquer lui-même ou se retirer les
    // droits et perdre l'accès à l'administration.
    if (id === currentUser.id) throw new BadRequestException('Vous ne pouvez pas modifier votre propre compte');

    const existing = await this.prisma.appUser.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Compte introuvable');

    // ADMIN_EMAILS est un plancher garanti : un compte qui y figure ne peut
    // être ni bloqué ni rétrogradé depuis l'interface, sous peine de perdre
    // tout accès administrateur sans intervention SQL directe.
    const isConfiguredAdmin = adminEmailsFromEnv().includes(existing.email.toLowerCase());
    if (isConfiguredAdmin && (patch.status === 'BLOCKED' || patch.isAdmin === false)) {
      throw new BadRequestException('Ce compte est administrateur par configuration (ADMIN_EMAILS) : modifiez le fichier .env pour le retirer');
    }

    return this.prisma.appUser.update({ where: { id }, data: patch, select: SAFE_SELECT });
  }
}
