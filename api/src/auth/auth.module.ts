import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { CavesModule } from '../caves/caves.module';
import { AdminGuard } from './admin.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { GoogleStrategy } from './google.strategy';
import { PendingGuard } from './pending.guard';
import { SessionSerializer } from './session.serializer';

@Module({
  imports: [PassportModule.register({ session: true }), CavesModule],
  controllers: [AuthController],
  // PendingGuard est la seule garde globale : elle ne fait que tenir un compte
  // en attente de validation à l'écart de tout ce qui n'est pas @AllowPending().
  providers: [AuthService, GoogleStrategy, SessionSerializer, AuthenticatedGuard, AdminGuard, { provide: APP_GUARD, useClass: PendingGuard }],
  exports: [AuthService, AuthenticatedGuard, AdminGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly auth: AuthService) {}
  async onModuleInit() {
    await this.auth.ensureBreakGlassAccount();
  }
}
