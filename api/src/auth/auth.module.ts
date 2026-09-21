import { Module, OnModuleInit } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminGuard } from './admin.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { GoogleStrategy } from './google.strategy';
import { SessionSerializer } from './session.serializer';

@Module({
  imports: [PassportModule.register({ session: true })],
  controllers: [AuthController],
  providers: [AuthService, GoogleStrategy, SessionSerializer, AuthenticatedGuard, AdminGuard],
  exports: [AuthService, AuthenticatedGuard, AdminGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly auth: AuthService) {}
  async onModuleInit() {
    await this.auth.ensureBreakGlassAccount();
  }
}
