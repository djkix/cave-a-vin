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

  async findOrCreateGoogleUser(profile: GoogleProfile): Promise<AppUser> {
    const existing = await this.prisma.appUser.findUnique({ where: { googleSub: profile.sub } });
    if (existing) return existing;

    const email = profile.email.toLowerCase();
    const allowed = await this.prisma.allowedEmail.findUnique({ where: { email } });
    if (!allowed) throw new ForbiddenException('Adresse non autorisée');

    const byEmail = await this.prisma.appUser.findUnique({ where: { email } });
    if (byEmail && byEmail.googleSub === null) {
      return this.prisma.appUser.update({
        where: { id: byEmail.id },
        data: { googleSub: profile.sub, displayName: profile.displayName },
      });
    }

    return this.prisma.appUser.create({
      data: { googleSub: profile.sub, email, displayName: profile.displayName },
    });
  }

  async verifyLocalLogin(email: string, password: string): Promise<AppUser | null> {
    const user = await this.prisma.appUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.isBreakGlass || !user.passwordHash) return null;
    return (await argon2.verify(user.passwordHash, password)) ? user : null;
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
