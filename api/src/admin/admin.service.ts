import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { adminEmailsFromEnv } from '../auth/admin-emails';
import { CavesService } from '../caves/caves.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly caves: CavesService,
  ) {}

  /** `hasCave` : le compte possède une cave (sinon l'écran propose « Créer sa cave »). */
  async listUsers() {
    const users = await this.prisma.appUser.findMany({
      orderBy: { createdAt: 'desc' },
      select: { ...SAFE_SELECT, _count: { select: { ownedCaves: true } } },
    });
    return users.map(({ _count, ...user }) => ({ ...user, hasCave: _count.ownedCaves > 0 }));
  }

  /** Inscriptions Google en attente de validation, de la plus ancienne à la plus récente. */
  listRegistrations() {
    return this.prisma.appUser.findMany({
      where: { status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, email: true, displayName: true, createdAt: true },
    });
  }

  /**
   * Valider : le compte devient actif et reçoit sa cave, dont il est OWNER, en
   * une transaction. La mise à jour conditionnelle (encore PENDING) empêche
   * deux validations simultanées de créer deux caves.
   */
  async validateRegistration(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.appUser.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'ACTIVE' } });
      if (count === 0) throw new NotFoundException('Inscription introuvable');
      const user = await tx.appUser.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, displayName: true } });
      const cave = await this.caves.createOwnedCave(tx, user);
      return { id: user.id, status: 'ACTIVE' as const, cave: { id: cave.id, name: cave.name } };
    });
  }

  async refuseRegistration(id: string) {
    const { count } = await this.prisma.appUser.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'BLOCKED' } });
    if (count === 0) throw new NotFoundException('Inscription introuvable');
    return { id, status: 'BLOCKED' as const };
  }

  /**
   * « Créer sa cave » pour un compte actif qui n'en a pas (un membre invité,
   * par exemple). Le verrou sur le compte sérialise deux demandes simultanées.
   */
  async createCaveFor(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM app_user WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Compte introuvable');
      const user = await tx.appUser.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, displayName: true, status: true } });
      if (user.status !== 'ACTIVE') throw new BadRequestException('Seul un compte actif peut recevoir une cave');
      if (await tx.cave.findFirst({ where: { ownerId: id }, select: { id: true } })) throw new ConflictException('Ce compte a déjà une cave');
      const cave = await this.caves.createOwnedCave(tx, user);
      return { id: cave.id, name: cave.name };
    });
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
