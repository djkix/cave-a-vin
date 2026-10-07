import { createParamDecorator, ExecutionContext, InternalServerErrorException, SetMetadata } from '@nestjs/common';
import { CaveRole as CaveRoleName } from '@prisma/client';
import type { CaveAccess } from './cave-context.service';

export const CAVE_ROLE = 'caveRole';

/** Propriété de la requête où CaveAccessGuard dépose la cave courante. */
const CAVE_ACCESS = 'caveAccess';

/**
 * Rôle minimal exigé dans la cave courante (OWNER satisfait VIEWER). Posé sur
 * une méthode, ou sur le contrôleur (une méthode peut alors le changer).
 * Obligatoire sur toute route gardée par CaveAccessGuard.
 */
export const CaveRole = (minimum: CaveRoleName) => SetMetadata(CAVE_ROLE, minimum);

export function attachCave(req: object, access: CaveAccess): void {
  (req as Record<string, unknown>)[CAVE_ACCESS] = access;
}

/** Cave courante déposée par la garde ; `required` : refuse (500) si la garde n'est pas passée. */
export function currentCaveOf(req: object, required: true): CaveAccess;
export function currentCaveOf(req: object, required?: boolean): CaveAccess | undefined;
export function currentCaveOf(req: object, required = false): CaveAccess | undefined {
  const access = (req as Record<string, unknown>)[CAVE_ACCESS] as CaveAccess | undefined;
  if (!access && required) throw new InternalServerErrorException('Cave courante non résolue');
  return access;
}

/** `{ caveId, role }` de la cave courante, résolue par CaveAccessGuard. */
export const CurrentCave = createParamDecorator((_data: unknown, ctx: ExecutionContext): CaveAccess =>
  currentCaveOf(ctx.switchToHttp().getRequest(), true),
);
