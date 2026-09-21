import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseFilters, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppUser } from '@prisma/client';
import { Request, Response } from 'express';
import { loadEnv } from '../config/env';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { CurrentUser } from './current-user.decorator';
import { OAuthRedirectFilter } from './oauth-redirect.filter';

// Même forme que côté web (type Me) : local-login et /auth/me ne doivent pas
// diverger, sinon la connexion locale mentirait sur isAdmin/status jusqu'au
// prochain getMe().
function toMe(user: AppUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin, status: user.status };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
    return toMe(user);
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    await new Promise<void>((resolve, reject) => req.logout((err) => (err ? reject(err) : resolve())));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthenticatedGuard)
  me(@CurrentUser() user: AppUser) {
    return toMe(user);
  }
}
