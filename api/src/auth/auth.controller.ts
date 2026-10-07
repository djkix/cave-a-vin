import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppUser } from '@prisma/client';
import { Request, Response } from 'express';
import { z } from 'zod';
import { CaveContextService } from '../caves/cave-context.service';
import { loadEnv } from '../config/env';
import { AllowPending } from './allow-pending.decorator';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { CurrentUser } from './current-user.decorator';
import { OAuthRedirectFilter } from './oauth-redirect.filter';
import './session-data';

const currentCaveSchema = z.object({ caveId: z.string().min(1).max(64) });

// Les routes d'authentification restent ouvertes à un compte en attente de
// validation (PendingGuard) : il doit pouvoir se connecter, voir son statut et
// se déconnecter.
@Controller('auth')
@AllowPending()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly caveContext: CaveContextService,
  ) {}

  // Même forme que côté web (type Me) : local-login, /auth/me et
  // /auth/current-cave ne doivent pas diverger, sinon la connexion locale
  // mentirait sur isAdmin/status jusqu'au prochain getMe(). La cave courante
  // est résolue à chaque appel (une cave retirée ne reste pas choisie) et
  // recopiée dans la session.
  private async toMe(user: AppUser, req: Request) {
    const caves = user.status === 'PENDING' ? [] : await this.caveContext.listForUser(user.id);
    const current = user.status === 'PENDING' ? null : await this.caveContext.resolveCurrent(user.id, req.session.caveId);
    if (current && req.session.caveId !== current.caveId) req.session.caveId = current.caveId;
    if (!current && req.session.caveId !== undefined) delete req.session.caveId;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      status: user.status,
      caves,
      currentCaveId: current?.caveId ?? null,
    };
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  google() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @UseFilters(OAuthRedirectFilter)
  googleCallback(@Req() req: Request, @Res() res: Response) {
    req.logIn(req.user as AppUser, (err) => {
      if (err) return res.redirect(`${loadEnv().WEB_ORIGIN}/login?error=session`);
      return res.redirect(loadEnv().WEB_ORIGIN);
    });
  }

  // 5 tentatives par minute et par IP : le compte de secours est protégé par un
  // seul mot de passe, il ne doit pas pouvoir être attaqué en force brute.
  @Post('local-login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async localLogin(@Body() body: { email: string; password: string }, @Req() req: Request) {
    const user = await this.auth.verifyLocalLogin(body.email ?? '', body.password ?? '');
    if (!user) throw new UnauthorizedException('Identifiants invalides');
    await new Promise<void>((resolve, reject) => req.logIn(user, (err) => (err ? reject(err) : resolve())));
    return this.toMe(user, req);
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    await new Promise<void>((resolve, reject) => req.logout((err) => (err ? reject(err) : resolve())));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthenticatedGuard)
  me(@CurrentUser() user: AppUser, @Req() req: Request) {
    return this.toMe(user, req);
  }

  // Un compte en attente n'a pas de cave à choisir : route refermée.
  @Put('current-cave')
  @AllowPending(false)
  @UseGuards(AuthenticatedGuard)
  async setCurrentCave(@Body() body: unknown, @CurrentUser() user: AppUser, @Req() req: Request) {
    const parsed = currentCaveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Cave invalide');
    const access = await this.caveContext.findAccess(user.id, parsed.data.caveId);
    if (!access) throw new NotFoundException('Cave introuvable');
    req.session.caveId = access.caveId;
    return this.toMe(user, req);
  }
}
