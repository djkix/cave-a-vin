import { createParamDecorator, ExecutionContext, InternalServerErrorException, SetMetadata } from '@nestjs/common';
import { CaveRole as CaveRoleName } from '@prisma/client';
import type { Request } from 'express';
import type { CaveAccess } from './cave-context.service';

declare module 'express-serve-static-core' {
  interface Request {
    /** Cave courante déposée par CaveAccessGuard. */
    caveAccess?: CaveAccess;
  }
}

export const CAVE_ROLE = 'caveRole';

/**
 * Rôle minimal exigé dans la cave courante (OWNER satisfait VIEWER). Posé sur
 * une méthode, ou sur le contrôleur (une méthode peut alors le changer).
 * Obligatoire sur toute route gardée par CaveAccessGuard.
 */
export const CaveRole = (minimum: CaveRoleName) => SetMetadata(CAVE_ROLE, minimum);

/** Cave courante de la requête ; refuse (500) si la garde n'est pas passée. */
export function requireCave(req: Pick<Request, 'caveAccess'>): CaveAccess {
  if (!req.caveAccess) throw new InternalServerErrorException('Cave courante non résolue');
  return req.caveAccess;
}

/** `{ caveId, role }` de la cave courante, résolue par CaveAccessGuard. */
export const CurrentCave = createParamDecorator((_data: unknown, ctx: ExecutionContext): CaveAccess =>
  requireCave(ctx.switchToHttp().getRequest<Request>()),
);
