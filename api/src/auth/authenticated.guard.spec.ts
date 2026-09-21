import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AuthenticatedGuard } from './authenticated.guard';

function contextWith(req: { isAuthenticated?: () => boolean; user?: Partial<AppUser> }) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

describe('AuthenticatedGuard', () => {
  const guard = new AuthenticatedGuard();

  it('refuses a request with no session', () => {
    expect(() => guard.canActivate(contextWith({ isAuthenticated: () => false }))).toThrow(UnauthorizedException);
  });

  it('refuses a blocked account even with a valid session, so a block cuts an open session', () => {
    expect(() =>
      guard.canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'BLOCKED' } })),
    ).toThrow(ForbiddenException);
  });

  it('accepts an active, authenticated account', () => {
    expect(guard.canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'ACTIVE' } }))).toBe(true);
  });
});
