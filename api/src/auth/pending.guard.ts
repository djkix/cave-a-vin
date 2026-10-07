import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUser } from '@prisma/client';
import { Request } from 'express';
import { ALLOW_PENDING } from './allow-pending.decorator';

/**
 * Garde globale : un compte en attente de validation a une session, mais ne
 * peut appeler que les routes marquées @AllowPending() (connexion, /auth/me,
 * déconnexion, santé). Sans session, elle laisse passer : les gardes de route
 * (AuthenticatedGuard, AdminGuard) répondent 401 comme avant.
 */
@Injectable()
export class PendingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.isAuthenticated || !req.isAuthenticated()) return true;
    if ((req.user as AppUser | undefined)?.status !== 'PENDING') return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING, [context.getHandler(), context.getClass()])) return true;
    throw new ForbiddenException('Inscription en attente de validation');
  }
}
