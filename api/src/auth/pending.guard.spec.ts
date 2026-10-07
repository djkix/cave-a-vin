import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUser } from '@prisma/client';
import { PendingGuard } from './pending.guard';

function contextWith(req: { isAuthenticated?: () => boolean; user?: Partial<AppUser> }) {
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as any;
}

describe('PendingGuard', () => {
  const reflector = (allowed: boolean) => ({ getAllAndOverride: () => allowed }) as unknown as Reflector;

  it('laisse passer une requête sans session (les gardes de route décident)', () => {
    expect(new PendingGuard(reflector(false)).canActivate(contextWith({ isAuthenticated: () => false }))).toBe(true);
  });

  it('laisse passer un compte actif', () => {
    expect(new PendingGuard(reflector(false)).canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'ACTIVE' } }))).toBe(true);
  });

  it('refuse un compte en attente, en français', () => {
    const guard = new PendingGuard(reflector(false));
    expect(() => guard.canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'PENDING' } }))).toThrow(
      new ForbiddenException('Inscription en attente de validation'),
    );
  });

  it('laisse passer un compte en attente sur une route marquée @AllowPending()', () => {
    expect(new PendingGuard(reflector(true)).canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'PENDING' } }))).toBe(true);
  });
});
