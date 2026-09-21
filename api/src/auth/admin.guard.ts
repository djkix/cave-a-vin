import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { Request } from 'express';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.isAuthenticated || !req.isAuthenticated()) throw new UnauthorizedException('Connexion requise');
    const user = req.user as AppUser | undefined;
    if (user?.status === 'BLOCKED') throw new ForbiddenException('Compte bloqué');
    if (!user?.isAdmin) throw new ForbiddenException('Réservé à l’administrateur');
    return true;
  }
}
