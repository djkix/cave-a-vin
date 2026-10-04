import { createOutSchema, inventorySchema } from './dto';

describe('createOutSchema', () => {
  it('renvoie des messages en français pour les champs requis manquants', () => {
    const result = createOutSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(['idempotencyKey invalide', 'Vin invalide', 'La quantité doit être positive']),
    );
    expect(messages.join(' ')).not.toMatch(/required/i);
  });

  it('refuse en français une quantité non entière ou négative', () => {
    const result = createOutSchema.safeParse({
      idempotencyKey: '11111111-1111-1111-1111-111111111111',
      wineId: '22222222-2222-2222-2222-222222222222',
      quantity: -1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message)).toContain('La quantité doit être positive');
  });

  it('refuse en français une photoId qui n’est pas un UUID', () => {
    const result = createOutSchema.safeParse({
      idempotencyKey: '11111111-1111-1111-1111-111111111111',
      wineId: '22222222-2222-2222-2222-222222222222',
      quantity: 1,
      photoId: 'pas-un-uuid',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message)).toContain('Photo invalide');
  });
});

describe('inventorySchema', () => {
  it('renvoie un message en français quand counted est manquant', () => {
    const result = inventorySchema.safeParse({ idempotencyKey: '11111111-1111-1111-1111-111111111111' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toContain('Nombre de bouteilles invalide');
    expect(messages.join(' ')).not.toMatch(/required/i);
  });
});

describe('inventorySchema — borne haute', () => {
  it('refuse en français un compte démesuré qui déborderait la colonne', () => {
    const result = inventorySchema.safeParse({ idempotencyKey: '11111111-1111-1111-1111-111111111111', counted: 3_000_000_000 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message)).toContain('Nombre de bouteilles trop élevé');
  });

  it('accepte 100 000 bouteilles', () => {
    expect(inventorySchema.safeParse({ idempotencyKey: '11111111-1111-1111-1111-111111111111', counted: 100000 }).success).toBe(true);
  });
});
