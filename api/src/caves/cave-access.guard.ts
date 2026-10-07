import { CanActivate, ExecutionContext, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUser, CaveRole } from '@prisma/client';
import { Request } from 'express';
import { attachCave, CAVE_ROLE } from './cave-access.decorators';
import { CaveContextService } from './cave-context.service';

const RANK: Record<CaveRole, number> = { VIEWER: 1, OWNER: 2 };

/**
 * Garde des routes de cave : résout la cave courante du compte (session, sinon
 * sa cave OWNER, sinon sa plus ancienne invitation) et vérifie le rôle minimal
 * déclaré par @CaveRole. Aucun accès → 404 « Cave introuvable » ; rôle
 * insuffisant → 403 « Lecture seule ». Le contexte `{ caveId, role }` est lu
 * par @CurrentCave(). Une route sans @CaveRole est refusée (erreur de
 * programmation), jamais ouverte sans cave.
 */
@Injectable()
export class CaveAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly caves: CaveContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const minimum = this.reflector.getAllAndOverride<CaveRole | undefined>(CAVE_ROLE, [context.getHandler(), context.getClass()]);
    if (minimum !== 'OWNER' && minimum !== 'VIEWER') {
      throw new InternalServerErrorException('Route de cave sans rôle déclaré');
    }
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.isAuthenticated || !req.isAuthenticated()) throw new UnauthorizedException('Connexion requise');
    const user = req.user as AppUser;

    const access = await this.caves.resolveCurrent(user.id, req.session?.caveId ?? null);
    if (!access) throw new NotFoundException('Cave introuvable');
    if (RANK[access.role] < RANK[minimum]) throw new ForbiddenException('Lecture seule');
    attachCave(req, access);
    return true;
  }
}
