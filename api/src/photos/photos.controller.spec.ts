import { BadRequestException } from '@nestjs/common';
import { PhotosController } from './photos.controller';

describe('PhotosController — GET :id/image', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  function setup(status = 'DONE') {
    const photos = {
      findById: jest.fn(async () => ({ id, status })),
      readNormalized: jest.fn(async () => Buffer.from('origine')),
      readDisplay: jest.fn(async () => Buffer.from('affichage')),
    };
    const res = { setHeader: jest.fn(), send: jest.fn() };
    return { controller: new PhotosController(photos as any), photos, res };
  }

  it('sans paramètre : l’image d’origine, comme avant', async () => {
    const { controller, photos, res } = setup();
    await controller.image(id, undefined, res as any);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('origine'));
    expect(photos.readDisplay).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
  });

  it('variant=display : la version d’affichage', async () => {
    const { controller, photos, res } = setup();
    await controller.image(id, 'display', res as any);
    expect(photos.readDisplay).toHaveBeenCalledWith(id);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('affichage'));
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
  });

  it('variant=display sur une photo en attente : pas de mise en cache par le navigateur', async () => {
    const { controller, res } = setup('PENDING');
    await controller.image(id, 'display', res as any);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
  });

  it('variante inconnue : 400 « Variante d’image inconnue »', async () => {
    const { controller, photos, res } = setup();
    const call = controller.image(id, 'geante', res as any);
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.image(id, 'geante', res as any)).rejects.toThrow("Variante d'image inconnue");
    expect(res.send).not.toHaveBeenCalled();
    expect(photos.readNormalized).not.toHaveBeenCalled();
  });
});
