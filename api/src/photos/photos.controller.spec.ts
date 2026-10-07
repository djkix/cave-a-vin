import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PhotosController } from './photos.controller';

describe('PhotosController — GET :id/image', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  const user = { id: 'u1' } as any;

  function setup(status = 'DONE', access: { caveId: string; role: string } | null = { caveId: 'c1', role: 'VIEWER' }) {
    const photos = {
      findById: jest.fn(async () => ({ id, status, caveId: 'c1' })),
      readNormalized: jest.fn(async () => Buffer.from('origine')),
      readDisplay: jest.fn(async () => Buffer.from('affichage')),
    };
    const res = { setHeader: jest.fn(), send: jest.fn() };
    const caves = { findAccess: jest.fn(async () => access) };
    return { controller: new PhotosController(photos as any, caves as any), photos, caves, res };
  }

  it('sans paramètre : l’image d’origine, comme avant', async () => {
    const { controller, photos, res } = setup();
    await controller.image(user, id, undefined, res as any);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('origine'));
    expect(photos.readDisplay).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
  });

  it('variant=display : la version d’affichage', async () => {
    const { controller, photos, res } = setup();
    await controller.image(user, id, 'display', res as any);
    expect(photos.readDisplay).toHaveBeenCalledWith(id);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('affichage'));
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
  });

  it('variant=display sur une photo en attente : pas de mise en cache par le navigateur', async () => {
    const { controller, res } = setup('PENDING');
    await controller.image(user, id, 'display', res as any);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
  });

  it('variante inconnue : 400 « Variante d’image inconnue »', async () => {
    const { controller, photos, res } = setup();
    const call = controller.image(user, id, 'geante', res as any);
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.image(user, id, 'geante', res as any)).rejects.toThrow("Variante d'image inconnue");
    expect(res.send).not.toHaveBeenCalled();
    expect(photos.readNormalized).not.toHaveBeenCalled();
  });

  it('photo d’une cave où le compte est membre (même en lecture, même hors de la cave courante) : servie', async () => {
    const { controller, caves, res } = setup('DONE', { caveId: 'c1', role: 'VIEWER' });
    await controller.image(user, id, 'display', res as any);
    expect(caves.findAccess).toHaveBeenCalledWith('u1', 'c1');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('affichage'));
  });

  it('photo d’une cave sans accès : 404 « Photo introuvable », rien n’est lu', async () => {
    const { controller, photos, res } = setup('DONE', null);
    await expect(controller.image(user, id, undefined, res as any)).rejects.toThrow(new NotFoundException('Photo introuvable'));
    expect(photos.readNormalized).not.toHaveBeenCalled();
    expect(photos.readDisplay).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
