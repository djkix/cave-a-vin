import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
import { AppUser } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  serializeUser(user: AppUser, done: (err: Error | null, id: string) => void) {
    done(null, user.id);
  }
  async deserializeUser(id: string, done: (err: Error | null, user: AppUser | null) => void) {
    done(null, await this.prisma.appUser.findUnique({ where: { id } }));
  }
}
