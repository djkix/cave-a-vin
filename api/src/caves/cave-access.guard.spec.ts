import { ExecutionContext, ForbiddenException, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CaveAccessGuard } from './cave-access.guard';
import { CaveRole, CurrentCave, currentCaveOf } from './cave-access.decorators';

class Routes {
  @CaveRole('VIEWER') read() {}
  @CaveRole('OWNER') write() {}
  undeclared() {}
}

@CaveRole('OWNER')
class OwnerController {
  inherited() {}
  @CaveRole('VIEWER') overridden() {}
}

function context(handler: (...args: never[]) => unknown, cls: new () => unknown, req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function signedIn(session: Record<string, unknown> = {}) {
  return { isAuthenticated: () => true, user: { id: 'u1', status: 'ACTIVE' }, session } as Record<string, unknown>;
}

function guardWith(access: { caveId: string; role: 'OWNER' | 'VIEWER' } | null) {
  const resolveCurrent = jest.fn(async () => access);
  return { guard: new CaveAccessGuard(new Reflector(), { resolveCurrent } as never), resolveCurrent };
}

describe('CaveAccessGuard', () => {
  it('résout la cave courante depuis la session et l’attache à la requête', async () => {
    const { guard, resolveCurrent } = guardWith({ caveId: 'c1', role: 'OWNER' });
    const req = signedIn({ caveId: 'c1' });
    await expect(guard.canActivate(context(Routes.prototype.write, Routes, req))).resolves.toBe(true);
    expect(resolveCurrent).toHaveBeenCalledWith('u1', 'c1');
    expect(currentCaveOf(req)).toEqual({ caveId: 'c1', role: 'OWNER' });
  });

  it('sans cave accessible : 404 « Cave introuvable »', async () => {
    const { guard } = guardWith(null);
    const run = guard.canActivate(context(Routes.prototype.read, Routes, signedIn()));
    await expect(run).rejects.toBeInstanceOf(NotFoundException);
    await expect(guard.canActivate(context(Routes.prototype.read, Routes, signedIn()))).rejects.toThrow('Cave introuvable');
  });

  it('un VIEWER sur une route OWNER : 403 « Lecture seule »', async () => {
    const { guard } = guardWith({ caveId: 'c1', role: 'VIEWER' });
    const req = signedIn();
    await expect(guard.canActivate(context(Routes.prototype.write, Routes, req))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context(Routes.prototype.write, Routes, req))).rejects.toThrow('Lecture seule');
    expect(currentCaveOf(req)).toBeUndefined();
  });

  it('un VIEWER lit, un OWNER lit aussi (OWNER satisfait VIEWER)', async () => {
    for (const role of ['VIEWER', 'OWNER'] as const) {
      const { guard } = guardWith({ caveId: 'c1', role });
      const req = signedIn();
      await expect(guard.canActivate(context(Routes.prototype.read, Routes, req))).resolves.toBe(true);
      expect(currentCaveOf(req)).toEqual({ caveId: 'c1', role });
    }
  });

  it('route sans @CaveRole : refus (erreur de programmation), sans même chercher la cave', async () => {
    const { guard, resolveCurrent } = guardWith({ caveId: 'c1', role: 'OWNER' });
    const req = signedIn();
    await expect(guard.canActivate(context(Routes.prototype.undeclared, Routes, req))).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(resolveCurrent).not.toHaveBeenCalled();
    expect(currentCaveOf(req)).toBeUndefined();
  });

  it('le rôle de la méthode l’emporte sur celui du contrôleur', async () => {
    const { guard } = guardWith({ caveId: 'c1', role: 'VIEWER' });
    await expect(guard.canActivate(context(OwnerController.prototype.overridden, OwnerController, signedIn()))).resolves.toBe(true);
    await expect(guard.canActivate(context(OwnerController.prototype.inherited, OwnerController, signedIn()))).rejects.toThrow('Lecture seule');
  });

  it('sans session : 401', async () => {
    const { guard, resolveCurrent } = guardWith({ caveId: 'c1', role: 'OWNER' });
    await expect(guard.canActivate(context(Routes.prototype.read, Routes, { isAuthenticated: () => false }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolveCurrent).not.toHaveBeenCalled();
  });
});

describe('@CurrentCave()', () => {
  it('refuse une requête sans contexte de cave (garde absente)', () => {
    expect(() => currentCaveOf({}, true)).toThrow(InternalServerErrorException);
    expect(CurrentCave).toBeDefined();
  });
});
