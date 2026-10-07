import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { loadEnv } from '../config/env';
import { CavesService } from '../caves/caves.service';
import { PrismaService } from '../prisma/prisma.service';
import { adminEmailsFromEnv } from './admin-emails';

export interface GoogleProfile {
  sub: string;
  email: string;
  displayName: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly caves: CavesService,
  ) {}

  // ADMIN_EMAILS est un plancher garanti, jamais un plafond : une adresse listée
  // est toujours administrateur (le propriétaire ne peut jamais s'enfermer
  // dehors), mais une promotion faite depuis /admin sur un compte absent de la
  // liste reste durable d'une connexion à l'autre — on ne l'écrase jamais.
  private resolveIsAdmin(email: string, currentIsAdmin: boolean): boolean {
    return adminEmailsFromEnv().includes(email.toLowerCase()) || currentIsAdmin;
  }

  // Un administrateur resté en attente (compte créé avant que son adresse
  // n'entre dans ADMIN_EMAILS) est activé à la connexion ; un compte bloqué ne
  // l'est jamais, et un non-administrateur garde son statut.
  private resolveStatus(isAdmin: boolean, current: AppUser['status']): AppUser['status'] {
    return isAdmin && current === 'PENDING' ? 'ACTIVE' : current;
  }

  async findOrCreateGoogleUser(profile: GoogleProfile): Promise<AppUser> {
    const email = profile.email.toLowerCase();

    const existing = await this.prisma.appUser.findUnique({ where: { googleSub: profile.sub } });
    let user: AppUser;
    if (existing) {
      const isAdmin = this.resolveIsAdmin(email, existing.isAdmin);
      user = await this.prisma.appUser.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date(), isAdmin, status: this.resolveStatus(isAdmin, existing.status) },
      });
    } else {
      const byEmail = await this.prisma.appUser.findUnique({ where: { email } });
      if (byEmail && byEmail.googleSub === null) {
        const isAdmin = this.resolveIsAdmin(email, byEmail.isAdmin);
        user = await this.prisma.appUser.update({
          where: { id: byEmail.id },
          data: {
            googleSub: profile.sub,
            displayName: profile.displayName,
            lastLoginAt: new Date(),
            isAdmin,
            status: this.resolveStatus(isAdmin, byEmail.status),
          },
        });
      } else {
        user = await this.createGoogleUser(profile, email);
      }
    }

    // Le refus vient après la mise à jour : la date de dernière tentative
    // reste juste, mais un compte bloqué n'obtient jamais de session.
    if (user.status === 'BLOCKED') throw new ForbiddenException('Compte bloqué');

    // Cave migrée sans propriétaire : elle revient au premier administrateur
    // (Google, jamais le compte de secours) qui se connecte sans avoir de cave.
    if (user.isAdmin && user.status === 'ACTIVE' && !user.isBreakGlass) await this.caves.claimOrphanCave(user.id);
    return user;
  }

  /**
   * Adresse inconnue : ADMIN_EMAILS → actif et administrateur ; adresse
   * invitée par un propriétaire → active, et le compte remplace l'adresse dans
   * ses invitations ; sinon → en attente de validation. Les invitations sont
   * rattachées dans tous les cas (un administrateur peut aussi être invité).
   */
  private async createGoogleUser(profile: GoogleProfile, email: string): Promise<AppUser> {
    return this.prisma.$transaction(async (tx) => {
      const isAdmin = this.resolveIsAdmin(email, false);
      const invitations = await tx.caveMember.count({ where: { invitedEmail: email, userId: null } });
      const user = await tx.appUser.create({
        data: {
          googleSub: profile.sub,
          email,
          displayName: profile.displayName,
          lastLoginAt: new Date(),
          isAdmin,
          status: isAdmin || invitations > 0 ? 'ACTIVE' : 'PENDING',
        },
      });
      if (invitations > 0) {
        await tx.caveMember.updateMany({ where: { invitedEmail: email, userId: null }, data: { userId: user.id, invitedEmail: null } });
      }
      return user;
    });
  }

  async verifyLocalLogin(email: string, password: string): Promise<AppUser | null> {
    const user = await this.prisma.appUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.isBreakGlass || !user.passwordHash) return null;
    if (!(await argon2.verify(user.passwordHash, password))) return null;
    if (user.status === 'BLOCKED') return null;
    return this.prisma.appUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), isAdmin: this.resolveIsAdmin(user.email, user.isAdmin) },
    });
  }

  async ensureBreakGlassAccount(): Promise<void> {
    const env = loadEnv();
    if (!env.BREAK_GLASS_EMAIL || !env.BREAK_GLASS_PASSWORD) return;
    const passwordHash = await argon2.hash(env.BREAK_GLASS_PASSWORD);
    const email = env.BREAK_GLASS_EMAIL.toLowerCase();
    const existing = await this.prisma.appUser.findUnique({ where: { email } });
    if (existing) {
      await this.prisma.appUser.update({ where: { id: existing.id }, data: { passwordHash, isBreakGlass: true } });
    } else {
      await this.prisma.appUser.create({ data: { email, isBreakGlass: true, passwordHash, displayName: 'Secours' } });
    }
    this.logger.log(`Compte de secours prêt pour ${email}`);
  }
}
