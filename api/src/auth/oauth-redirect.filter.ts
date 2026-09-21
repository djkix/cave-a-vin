import { ArgumentsHost, Catch, ExceptionFilter, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
import { loadEnv } from '../config/env';

/**
 * Le retour Google est une navigation, pas un appel XHR : un refus (compte
 * bloqué, session non créée) doit ramener l'utilisateur sur l'écran de
 * connexion avec un message en français, pas afficher un JSON 403/401 brut
 * dans le navigateur.
 */
@Catch(ForbiddenException, UnauthorizedException)
export class OAuthRedirectFilter implements ExceptionFilter {
  catch(_exception: ForbiddenException | UnauthorizedException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().redirect(`${loadEnv().WEB_ORIGIN}/login?error=unauthorized`);
  }
}
