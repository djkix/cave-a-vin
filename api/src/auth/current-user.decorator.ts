import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppUser } from '@prisma/client';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AppUser => {
  return ctx.switchToHttp().getRequest().user as AppUser;
});
