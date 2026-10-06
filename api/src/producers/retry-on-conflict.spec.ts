import { Prisma } from '@prisma/client';
import { retryOnceOnUniqueConflict } from './retry-on-conflict';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

describe('retryOnceOnUniqueConflict', () => {
  it('rejoue une fois après une violation d’unicité (création concurrente)', async () => {
    const fn = jest.fn().mockRejectedValueOnce(p2002()).mockResolvedValueOnce('ok');
    await expect(retryOnceOnUniqueConflict(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ne rejoue qu’une fois', async () => {
    const fn = jest.fn().mockRejectedValue(p2002());
    await expect(retryOnceOnUniqueConflict(fn)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('laisse passer toute autre erreur sans rejouer', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('panne'));
    await expect(retryOnceOnUniqueConflict(fn)).rejects.toThrow('panne');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
