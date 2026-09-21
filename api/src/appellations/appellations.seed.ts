import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { AppellationsService } from './appellations.service';

async function main() {
  const prisma = new PrismaClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService extends PrismaClient with lifecycle hooks only; a plain PrismaClient works identically at runtime.
  const n = await new AppellationsService(prisma as any).seedFromFile(resolve(__dirname, '../../data/appellations.json'));
  console.log(`${n} appellations chargées`);
  await prisma.$disconnect();
}

void main();
