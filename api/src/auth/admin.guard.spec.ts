import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AdminGuard } from './admin.guard';

function contextWith(req: { isAuthenticated?: () => boolean; user?: Partial<AppUser> }) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('refuses a request with no session', () => {
    expect(() => guard.canActivate(contextWith({ isAuthenticated: () => false }))).toThrow(UnauthorizedException);
  });

  it('refuses a non-administrator', () => {
    expect(() =>
      guard.canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'ACTIVE', isAdmin: false } })),
    ).toThrow(ForbiddenException);
  });

  it('accepts an administrator', () => {
    expect(guard.canActivate(contextWith({ isAuthenticated: () => true, user: { status: 'ACTIVE', isAdmin: true } }))).toBe(true);
  });
});
