import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { loadEnv } from '../config/env';
import { AuthService } from './auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly auth: AuthService) {
    const env = loadEnv();
    super({
      clientID: env.GOOGLE_CLIENT_ID || 'unset',
      clientSecret: env.GOOGLE_CLIENT_SECRET || 'unset',
      callbackURL: env.GOOGLE_CALLBACK_URL,
      scope: ['openid', 'email', 'profile'],
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error('Profil Google sans adresse e-mail');
    // Une adresse non vérifiée ne prouve pas qu'on la possède : elle ne doit
    // jamais être reconnue par une invitation ni par ADMIN_EMAILS. Refus
    // (UnauthorizedException) : OAuthRedirectFilter ramène à l'écran de
    // connexion avec un message.
    const json = profile._json as { email_verified?: boolean | string } | undefined;
    if (profile.emails?.[0]?.verified === false || json?.email_verified === false || json?.email_verified === 'false') {
      throw new UnauthorizedException('Adresse Google non vérifiée');
    }
    return this.auth.findOrCreateGoogleUser({ sub: profile.id, email, displayName: profile.displayName });
  }
}
