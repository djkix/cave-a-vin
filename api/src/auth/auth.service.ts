import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface GoogleProfile {
  sub: string;
  email: string;
  displayName: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ADMIN_EMAILS est la seule façon de désigner un administrateur : dérivé à
  // chaque connexion, l'environnement reste la source de vérité (pas de
  // dérive possible via un droit accordé puis oublié en base).
  private adminEmails(): string[] {
    return loadEnv()
      .ADMIN_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
  }

  async findOrCreateGoogleUser(profile: GoogleProfile): Promise<AppUser> {
    const email = profile.email.toLowerCase();
    const isAdmin = this.adminEmails().includes(email);

    const existing = await this.prisma.appUser.findUnique({ where: { googleSub: profile.sub } });
    let user: AppUser;
    if (existing) {
      user = await this.prisma.appUser.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date(), isAdmin },
      });
    } else {
      const byEmail = await this.prisma.appUser.findUnique({ where: { email } });
      if (byEmail && byEmail.googleSub === null) {
        user = await this.prisma.appUser.update({
          where: { id: byEmail.id },
          data: { googleSub: profile.sub, displayName: profile.displayName, lastLoginAt: new Date(), isAdmin },
        });
      } else {
        user = await this.prisma.appUser.create({
          data: { googleSub: profile.sub, email, displayName: profile.displayName, lastLoginAt: new Date(), isAdmin },
        });
      }
    }

    // Le refus vient après la mise à jour : la date de dernière tentative
    // reste juste, mais un compte bloqué n'obtient jamais de session.
    if (user.status === 'BLOCKED') throw new ForbiddenException('Compte bloqué');
    return user;
  }

  async verifyLocalLogin(email: string, password: string): Promise<AppUser | null> {
    const user = await this.prisma.appUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.isBreakGlass || !user.passwordHash) return null;
    if (!(await argon2.verify(user.passwordHash, password))) return null;
    if (user.status === 'BLOCKED') return null;
    return this.prisma.appUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), isAdmin: this.adminEmails().includes(user.email.toLowerCase()) },
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
