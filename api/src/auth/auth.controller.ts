import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppUser } from '@prisma/client';
import { Request, Response } from 'express';
import { loadEnv } from '../config/env';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  google() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  googleCallback(@Req() req: Request, @Res() res: Response) {
    req.logIn(req.user as AppUser, (err) => {
      if (err) return res.redirect(`${loadEnv().WEB_ORIGIN}/login?error=session`);
      return res.redirect(loadEnv().WEB_ORIGIN);
    });
  }

  @Post('local-login')
  async localLogin(@Body() body: { email: string; password: string }, @Req() req: Request) {
    const user = await this.auth.verifyLocalLogin(body.email ?? '', body.password ?? '');
    if (!user) throw new UnauthorizedException('Identifiants invalides');
    await new Promise<void>((resolve, reject) => req.logIn(user, (err) => (err ? reject(err) : resolve())));
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    await new Promise<void>((resolve, reject) => req.logout((err) => (err ? reject(err) : resolve())));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthenticatedGuard)
  me(@CurrentUser() user: AppUser) {
    return { id: user.id, email: user.email, displayName: user.displayName };
  }
}
