import { GEMINI_PAUSE_REASON_KEY, GEMINI_PAUSE_UNTIL_KEY, GeminiJournal, GeminiPausedError } from './gemini-journal';
import { fakeGeminiPrisma as fakePrisma } from '../test-utils/fake-gemini-prisma';
import { GeminiVisionProvider, VisionBatchMismatchError } from './gemini-vision.provider';

const validObj = (overrides: Record<string, unknown> = {}) => ({
  producteur: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: null, confidence: 0 },
  appellation: { value: 'Bandol', confidence: 0.97 }, millesime: { value: 2019, confidence: 0.94 },
  couleur: { value: 'rouge', confidence: 0.99 }, format_cl: { value: 75, confidence: 0.9 },
  degre: { value: null, confidence: 0 }, pays_region: { value: 'Provence', confidence: 0.7 },
  nb_cols_carton: { value: 6, confidence: 0.85 }, confiance_globale: 0.93,
  ...overrides,
});

const validJson = JSON.stringify(validObj());

function fakeModel(text: string, usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }) {
  return { generateContent: jest.fn().mockResolvedValue({ response: { text: () => text, usageMetadata: usage } }) };
}

describe('GeminiVisionProvider', () => {
  it('sends the image with the JSON contract and parses the answer', async () => {
    const model = fakeModel(validJson);
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    const res = await provider.extractWineLabel(Buffer.from('img'), 'image/jpeg');
    expect(res.extraction.producer.value).toBe('Domaine Tempier');
    expect(res.model).toBe('gemini-test');
    expect(res.raw).toEqual(JSON.parse(validJson));
    const call = model.generateContent.mock.calls[0][0];
    expect(JSON.stringify(call)).toContain('nb_cols_carton');
    expect(call.generationConfig.responseMimeType).toBe('application/json');
  });

  it('strips a ```json fence before parsing', async () => {
    const provider = new GeminiVisionProvider(fakeModel('```json\n' + validJson + '\n```') as any, 'm');
    await expect(provider.extractWineLabel(Buffer.from('x'), 'image/jpeg')).resolves.toBeDefined();
  });

  it('throws a VisionInvalidOutputError on garbage', async () => {
    const provider = new GeminiVisionProvider(fakeModel('pas du json') as any, 'm');
    await expect(provider.extractWineLabel(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/sortie du modèle invalide/i);
  });
});

describe('GeminiVisionProvider.suggestPairingsBatch', () => {
  const tempier = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019 };
  const trimbach = { producer: 'Trimbach', cuvee: null, appellation: 'Alsace', region: null, color: 'BLANC', vintage: null };
  const fake = (text: string, usage = { promptTokenCount: 200, candidatesTokenCount: 50 }) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => text, usageMetadata: usage } })),
  });
  const promptOf = (model: ReturnType<typeof fake>) => (model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text as string;

  it('demande en un seul appel un tableau numéroté de plats en français et rend chaque liste à la position de son vin', async () => {
    const model = fake(JSON.stringify([
      { vin: 2, plats: ['Choucroute', 'Munster'] },
      { vin: 1, plats: ['Agneau de sept heures', 'Daube provençale'] },
    ]));
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairingsBatch([tempier, trimbach]);
    expect(r).toEqual({
      items: [
        { index: 0, dishes: ['Agneau de sept heures', 'Daube provençale'] },
        { index: 1, dishes: ['Choucroute', 'Munster'] },
      ],
      model: 'gemini-test',
      costCents: 0,
    });
    expect(model.generateContent).toHaveBeenCalledTimes(1);
    const prompt = promptOf(model);
    expect(prompt).toContain('Tu es sommelier');
    expect(prompt).toContain('de 5 à 8 plats');
    expect(prompt).toContain('60 caractères au plus');
    expect(prompt).toContain('tableau JSON de 2 éléments');
    expect(prompt).toContain('Vin 1 : producteur « Domaine Tempier » ; cuvée « La Tourtine » ; appellation « Bandol » ; région « Provence » ; couleur rouge ; millésime 2019.');
    expect(prompt).toContain('Vin 2 : producteur « Trimbach » ; cuvée « aucune » ; appellation « Alsace » ; région « inconnue » ; couleur blanc ; non millésimé.');
    expect((model.generateContent.mock.calls[0] as any)[0].generationConfig.responseMimeType).toBe('application/json');
  });

  it('accepte une clôture ```json et un tableau enveloppé dans un objet', async () => {
    const model = fake('```json\n' + JSON.stringify({ vins: [{ vin: 1, plats: ['Agneau'] }] }) + '\n```');
    await expect(new GeminiVisionProvider(model as any, 'm').suggestPairingsBatch([tempier])).resolves.toMatchObject({ items: [{ index: 0, dishes: ['Agneau'] }] });
  });

  it('valide chaque vin avec les règles habituelles : un vin aux plats invalides est seulement absent du résultat', async () => {
    const model = fake(JSON.stringify([{ vin: 1, plats: [] }, { vin: 2, plats: ['Choucroute'] }]));
    const r = await new GeminiVisionProvider(model as any, 'm').suggestPairingsBatch([tempier, trimbach]);
    expect(r.items).toEqual([{ index: 1, dishes: ['Choucroute'] }]);
  });

  it.each([
    ['JSON illisible', 'pas du json'],
    ['pas un tableau', '{"plats": ["Agneau"]}'],
    ['taille incorrecte', JSON.stringify([{ vin: 1, plats: ['Agneau'] }])],
    ['indice manquant', JSON.stringify([{ vin: 1, plats: ['Agneau'] }, { plats: ['Choucroute'] }])],
    ['indice dupliqué', JSON.stringify([{ vin: 1, plats: ['Agneau'] }, { vin: 1, plats: ['Choucroute'] }])],
    ['indice hors bornes', JSON.stringify([{ vin: 1, plats: ['Agneau'] }, { vin: 3, plats: ['Choucroute'] }])],
  ])('lot mélangé (%s) : VisionBatchMismatchError, avec le coût de l’appel', async (_why, text) => {
    const model = fake(text, { promptTokenCount: 200000, candidatesTokenCount: 50000 });
    const e = await new GeminiVisionProvider(model as any, 'm').suggestPairingsBatch([tempier, trimbach]).catch((x) => x);
    expect(e).toBeInstanceOf(VisionBatchMismatchError);
    expect(e.message).toMatch(/^Sortie du modèle invalide/);
    expect(e.costCents).toBe(4);
  });

  it('arrondit (ne majore jamais) le coût total de l’appel', async () => {
    const model = fake(JSON.stringify([{ vin: 1, plats: ['Agneau'] }]), { promptTokenCount: 200000, candidatesTokenCount: 50000 });
    expect((await new GeminiVisionProvider(model as any, 'm').suggestPairingsBatch([tempier])).costCents).toBe(4);
  });
});

describe('GeminiVisionProvider.extractWineLabels', () => {
  const images = [
    { data: Buffer.from('img1'), mimeType: 'image/jpeg' },
    { data: Buffer.from('img2'), mimeType: 'image/jpeg' },
    { data: Buffer.from('img3'), mimeType: 'image/jpeg' },
  ];

  it('rend les 3 extractions à l’indice de leur photo, même si le tableau du modèle est désordonné', async () => {
    const arr = [
      { image: 3, ...validObj({ appellation: { value: 'Appellation 3', confidence: 0.9 } }) },
      { image: 1, ...validObj({ appellation: { value: 'Appellation 1', confidence: 0.9 } }) },
      { image: 2, ...validObj({ appellation: { value: 'Appellation 2', confidence: 0.9 } }) },
    ];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    const res = await provider.extractWineLabels(images);

    expect(res.model).toBe('gemini-test');
    expect(res.items).toHaveLength(3);
    expect((res.items[0] as any).extraction.appellation.value).toBe('Appellation 1');
    expect((res.items[1] as any).extraction.appellation.value).toBe('Appellation 2');
    expect((res.items[2] as any).extraction.appellation.value).toBe('Appellation 3');
  });

  it('isole un objet invalide : seul son indice devient une erreur', async () => {
    const arr = [
      { image: 1, ...validObj() },
      { image: 2, couleur: { value: 'turquoise', confidence: 0.5 } },
      { image: 3, ...validObj() },
    ];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    const res = await provider.extractWineLabels(images);

    expect((res.items[0] as any).extraction).toBeDefined();
    expect(res.items[1]).toEqual({ error: 'Lecture de l’étiquette inexploitable' });
    expect((res.items[2] as any).extraction).toBeDefined();
  });

  it('rejette une longueur de tableau différente de N', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
    await expect(provider.extractWineLabels(images)).rejects.toThrow(/sortie du modèle invalide/i);
  });

  it('rejette un indice dupliqué', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 1, ...validObj() }, { image: 3, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
  });

  it('rejette un JSON illisible', async () => {
    const model = fakeModel('pas du json');
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
  });

  it('rejette une réponse qui n’est pas un tableau', async () => {
    const model = fakeModel(JSON.stringify(validObj()));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
  });

  it('rejette un indice manquant (laissant un trou dans la plage 1..N)', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 2, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
  });

  it('un lot mélangé porte le coût de l’appel, déjà payé', async () => {
    const ok = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    const expected = (await new GeminiVisionProvider(fakeModel(JSON.stringify(ok)) as any, 'g').extractWineLabels(images)).costCents;
    expect(expected).toBeGreaterThan(0);
    const bad = [{ image: 1, ...validObj() }, { image: 1, ...validObj() }, { image: 3, ...validObj() }];
    const err = await new GeminiVisionProvider(fakeModel(JSON.stringify(bad)) as any, 'g').extractWineLabels(images).catch((e) => e);
    expect(err).toBeInstanceOf(VisionBatchMismatchError);
    expect(err.costCents).toBe(expected);
    const unreadable = await new GeminiVisionProvider(fakeModel('pas du json') as any, 'g').extractWineLabels(images).catch((e) => e);
    expect(unreadable.costCents).toBe(expected);
  });

  it('rejette un indice hors bornes', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 5, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
  });

  it('numérote les images de 1 à N dans la consigne et précède chaque image de « Image i : »', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    await provider.extractWineLabels(images);

    const call = model.generateContent.mock.calls[0][0];
    const parts = call.contents[0].parts;
    const texts = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text);
    expect(texts.some((t: string) => /3 images numérotées de 1 à 3/.test(t))).toBe(true);
    expect(texts).toContain('Image 1 :');
    expect(texts).toContain('Image 2 :');
    expect(texts).toContain('Image 3 :');
  });

  it('la consigne de lot demande un tableau de N éléments, jamais « un objet JSON strict »', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr));
    await new GeminiVisionProvider(model as any, 'gemini-test').extractWineLabels(images);
    const prompt = model.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(prompt).toMatch(/tableau JSON de 3 éléments/);
    expect(prompt).not.toMatch(/objet JSON strict/);
    expect(prompt).toContain('"image"');
    expect(prompt).toContain('nb_cols_carton');
  });

  it('les consignes simple et de lot partagent les mêmes règles de lecture', async () => {
    const single = fakeModel(validJson);
    await new GeminiVisionProvider(single as any, 'g').extractWineLabel(Buffer.from('x'), 'image/jpeg');
    const singlePrompt = single.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    const batch = fakeModel(JSON.stringify(arr));
    await new GeminiVisionProvider(batch as any, 'g').extractWineLabels(images);
    const batchPrompt = batch.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(singlePrompt).toMatch(/objet JSON strict/);
    for (const rule of [
      'null avec confidence 0',
      'producteur (domaine, château, maison) du nom de la cuvée',
      'nombre de bouteilles',
      'rouge | blanc | rosé | pétillant',
      'format_cl',
    ]) {
      expect(singlePrompt).toContain(rule);
      expect(batchPrompt).toContain(rule);
    }
  });

  it('les consignes simple et de lot demandent le cadre de l’étiquette, et le lot le rend', async () => {
    const single = fakeModel(JSON.stringify(validObj({ etiquette: [50, 100, 950, 900] })));
    const res = await new GeminiVisionProvider(single as any, 'g').extractWineLabel(Buffer.from('x'), 'image/jpeg');
    expect(res.extraction.labelBox).toEqual([50, 100, 950, 900]);
    const singlePrompt = single.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    const arr = [
      { image: 1, ...validObj({ etiquette: [10, 20, 900, 800] }) },
      { image: 2, ...validObj({ etiquette: null }) },
      { image: 3, ...validObj() },
    ];
    const batch = fakeModel(JSON.stringify(arr));
    const out = await new GeminiVisionProvider(batch as any, 'g').extractWineLabels(images);
    const batchPrompt = batch.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    for (const prompt of [singlePrompt, batchPrompt]) {
      expect(prompt).toContain('"etiquette"');
      expect(prompt).toMatch(/\[ymin, xmin, ymax, xmax\]/);
      expect(prompt).toMatch(/0 à 1000/);
    }
    expect(out.items.map((i) => ('extraction' in i ? i.extraction.labelBox : 'erreur'))).toEqual([[10, 20, 900, 800], null, null]);
  });

  it('accepte un tableau enveloppé dans un objet à une seule propriété tableau', async () => {
    const arr = [{ image: 2, ...validObj() }, { image: 1, ...validObj() }, { image: 3, ...validObj() }];
    for (const key of ['items', 'resultats']) {
      const provider = new GeminiVisionProvider(fakeModel(JSON.stringify({ [key]: arr })) as any, 'g');
      const res = await provider.extractWineLabels(images);
      expect(res.items).toHaveLength(3);
      expect(res.items.every((i) => 'extraction' in i)).toBe(true);
    }
  });

  it('rejette un objet à plusieurs propriétés tableau, ou sans tableau', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    for (const body of [{ a: arr, b: [] }, { items: { image: 1 } }]) {
      const provider = new GeminiVisionProvider(fakeModel(JSON.stringify(body)) as any, 'g');
      await expect(provider.extractWineLabels(images)).rejects.toThrow(VisionBatchMismatchError);
    }
  });

  it('facture le coût de l’appel entier (pas divisé ici)', async () => {
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }, { image: 3, ...validObj() }];
    const model = fakeModel(JSON.stringify(arr), { promptTokenCount: 3000, candidatesTokenCount: 600 });
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    const res = await provider.extractWineLabels(images);
    expect(res.costCents).toBe(Math.ceil((3000 / 1000) * 0.01 + (600 / 1000) * 0.04));
  });
});

describe('GeminiVisionProvider.describeProducersBatch', () => {
  const tempier = { producer: 'Domaine Tempier', appellations: ['Bandol'], region: 'Provence' };
  const closX = { producer: 'Clos X', appellations: [], region: null };
  const description = 'Domaine familial du Castellet, au cœur de l’appellation Bandol, réputé pour ses mourvèdres de garde.';
  const fake = (body: string, usage = { promptTokenCount: 200, candidatesTokenCount: 120 }) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => body, usageMetadata: usage } })),
  });
  const promptOf = (model: ReturnType<typeof fake>) => (model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text as string;

  it('demande en un seul appel un tableau numéroté de descriptifs en français et rend chacun à la position de son domaine', async () => {
    const model = fake(JSON.stringify([{ domaine: 2, connu: false }, { domaine: 1, connu: true, description }]));
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').describeProducersBatch([tempier, closX]);
    expect(r).toEqual({
      items: [
        { index: 0, known: true, description },
        { index: 1, known: false, description: null },
      ],
      model: 'gemini-test',
      costCents: 0,
    });
    expect(model.generateContent).toHaveBeenCalledTimes(1);
    const prompt = promptOf(model);
    expect(prompt).toMatch(/3 à 4 phrases/);
    expect(prompt).toContain('n\'invente rien');
    expect(prompt).toContain('"connu": false');
    expect(prompt).toContain('tableau JSON de 2 éléments');
    expect(prompt).toContain('Domaine 1 : « Domaine Tempier » ; appellation(s) de ses vins : « Bandol » ; région « Provence ».');
    expect(prompt).toContain('Domaine 2 : « Clos X » ; appellation(s) de ses vins : inconnue ; région « inconnue ».');
    expect((model.generateContent.mock.calls[0] as any)[0].generationConfig.responseMimeType).toBe('application/json');
  });

  it('valide chaque domaine avec les règles habituelles : un descriptif trop court est seulement absent du résultat', async () => {
    const model = fake(JSON.stringify([{ domaine: 1, connu: true, description: 'Bandol.' }, { domaine: 2, connu: false }]));
    const r = await new GeminiVisionProvider(model as any, 'm').describeProducersBatch([tempier, closX]);
    expect(r.items).toEqual([{ index: 1, known: false, description: null }]);
  });

  it.each([
    ['JSON illisible', 'pas du json'],
    ['indice manquant', JSON.stringify([{ domaine: 1, connu: false }, { connu: false }])],
    ['indice dupliqué', JSON.stringify([{ domaine: 2, connu: false }, { domaine: 2, connu: false }])],
  ])('lot mélangé (%s) : VisionBatchMismatchError, avec le coût de l’appel', async (_why, text) => {
    const model = fake(text, { promptTokenCount: 200000, candidatesTokenCount: 50000 });
    const e = await new GeminiVisionProvider(model as any, 'm').describeProducersBatch([tempier, closX]).catch((x) => x);
    expect(e).toBeInstanceOf(VisionBatchMismatchError);
    expect(e.costCents).toBe(4);
  });
});

describe('GeminiVisionProvider.findOfficialSite', () => {
  const query = { producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol', vintage: 2019 };
  const fake = (body: string, usage = { promptTokenCount: 300, candidatesTokenCount: 40 }) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => body, usageMetadata: usage } })),
  });
  const requestOf = (model: ReturnType<typeof fake>) => (model.generateContent.mock.calls[0] as any)[0];

  it('demande le site officiel avec la recherche Google et rend l’adresse', async () => {
    const model = fake('{"site": "https://www.domainetempier.com/"}');
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').findOfficialSite(query);
    expect(r).toEqual({ site: 'https://www.domainetempier.com/', model: 'gemini-test', costCents: 1 });
    const req = requestOf(model);
    expect(req.tools).toEqual([{ googleSearch: {} }]);
    const prompt = req.contents[0].parts[0].text as string;
    expect(prompt).toContain('Domaine Tempier');
    expect(prompt).toContain('La Migoua');
    expect(prompt).toContain('Bandol');
    expect(prompt).toContain('{"site": null}');
  });

  it('rend null quand le domaine n’a pas de site connu', async () => {
    expect((await new GeminiVisionProvider(fake('{"site": null}') as any, 'm').findOfficialSite(query)).site).toBeNull();
  });

  it('retrouve le JSON au milieu d’un texte ou d’une clôture (la recherche ancrée ne garantit pas un JSON pur)', async () => {
    const fenced = fake('```json\n{"site": "https://tempier.fr"}\n```');
    expect((await new GeminiVisionProvider(fenced as any, 'm').findOfficialSite(query)).site).toBe('https://tempier.fr/');
    const prose = fake('Voici le résultat : {"site": "https://tempier.fr/vins"} — bonne dégustation.');
    expect((await new GeminiVisionProvider(prose as any, 'm').findOfficialSite(query)).site).toBe('https://tempier.fr/vins');
  });

  it('rend null (avec le coût, déjà payé) pour une réponse inexploitable ou une adresse non http(s)', async () => {
    for (const body of ['pas du json', '{"site": "javascript:alert(1)"}', '{"site": 42}', '{"autre": 1}']) {
      const r = await new GeminiVisionProvider(fake(body, { promptTokenCount: 200000, candidatesTokenCount: 50000 }) as any, 'm').findOfficialSite(query);
      expect(r).toEqual({ site: null, model: 'm', costCents: 4 });
    }
  });

  it('compte au moins 1 ct par appel ancré, même pour un usage courant', async () => {
    const model = fake('{"site": null}', { promptTokenCount: 300, candidatesTokenCount: 40, toolUsePromptTokenCount: 1500 } as any);
    expect((await new GeminiVisionProvider(model as any, 'm').findOfficialSite(query)).costCents).toBe(1);
    const noUsage = { generateContent: jest.fn(async () => ({ response: { text: () => '{"site": null}', usageMetadata: undefined } })) };
    expect((await new GeminiVisionProvider(noUsage as any, 'm').findOfficialSite(query)).costCents).toBe(1);
  });

  it('majore un gros usage, jetons de la recherche (toolUsePromptTokenCount) compris', async () => {
    // (200 000 + 100 000) / 1000 × 0,01 + 50 000 / 1000 × 0,04 = 3 + 2 = 5 ; un jeton de sortie de plus → 5,00004, majoré à 6
    const exact = fake('{"site": null}', { promptTokenCount: 200000, candidatesTokenCount: 50000, toolUsePromptTokenCount: 100000 } as any);
    expect((await new GeminiVisionProvider(exact as any, 'm').findOfficialSite(query)).costCents).toBe(5);
    const above = fake('{"site": null}', { promptTokenCount: 200000, candidatesTokenCount: 50001, toolUsePromptTokenCount: 100000 } as any);
    expect((await new GeminiVisionProvider(above as any, 'm').findOfficialSite(query)).costCents).toBe(6);
  });

  it('compte aussi les requêtes de recherche ancrées (webSearchQueries) : 1,4 ct chacune, majoré', async () => {
    const withQueries = (queries: string[] | undefined, usage = { promptTokenCount: 300, candidatesTokenCount: 40 }) => ({
      generateContent: jest.fn(async () => ({
        response: { text: () => '{"site": null}', usageMetadata: usage, candidates: [{ groundingMetadata: queries ? { webSearchQueries: queries } : {} }] },
      })),
    });
    const cost = async (model: ReturnType<typeof withQueries>) => (await new GeminiVisionProvider(model as any, 'm').findOfficialSite(query)).costCents;
    expect(await cost(withQueries(['tempier']))).toBe(2); // 1,4 → 2
    expect(await cost(withQueries(['a', 'b', 'c']))).toBe(5); // 4,2 → 5
    expect(await cost(withQueries([]))).toBe(1);
    expect(await cost(withQueries(undefined))).toBe(1);
    // Les jetons l'emportent s'ils coûtent davantage : 300 000 / 1000 × 0,01 = 3 ct > 1,4 ct.
    expect(await cost(withQueries(['tempier'], { promptTokenCount: 300000, candidatesTokenCount: 0 }))).toBe(3);
  });

  it('transmet le signal d’abandon de la recherche à Gemini', async () => {
    const model = fake('{"site": null}');
    const signal = new AbortController().signal;
    await new GeminiVisionProvider(model as any, 'm').findOfficialSite(query, signal);
    expect((model.generateContent.mock.calls[0] as any)[1]).toEqual({ signal });
  });

  it('laisse remonter une panne de Gemini', async () => {
    const model = { generateContent: jest.fn(async () => { throw new Error('503 Service Unavailable'); }) };
    await expect(new GeminiVisionProvider(model as any, 'm').findOfficialSite(query)).rejects.toThrow('503');
  });
});

describe('GeminiVisionProvider — journal des appels et pause commune', () => {
  const NOW = new Date('2026-10-08T12:00:00.000Z');
  const GEMINI_503 = new Error('[GoogleGenerativeAI Error]: Error fetching from https://…:generateContent: [503 Service Unavailable] busy');
  const GEMINI_429 = new Error('[GoogleGenerativeAI Error]: Error fetching from https://…:generateContent: [429 Too Many Requests] quota');
  const wine = { producer: 'Domaine Tempier', cuvee: null, appellation: 'Bandol', region: null, color: 'ROUGE', vintage: 2019 };
  const failing = (e: Error) => ({ generateContent: jest.fn(async () => { throw e; }) });
  const journalOf = (prisma = fakePrisma()) => ({ prisma, journal: new GeminiJournal(prisma, { warn: jest.fn(), error: jest.fn() }, () => NOW) });

  it('note un appel réussi : usage, issue OK, coût et durée', async () => {
    const { prisma, journal } = journalOf();
    await new GeminiVisionProvider(fakeModel(validJson) as any, 'm', journal).extractWineLabel(Buffer.from('x'), 'image/jpeg');
    expect(prisma.calls).toEqual([
      { usage: 'LECTURE_SORTIE', outcome: 'OK', httpStatus: null, reason: null, costCents: 1, durationMs: expect.any(Number) },
    ]);
  });

  it('distingue lecture d’entrée (photo seule ou lot), accords, descriptifs et recherche d’image', async () => {
    const { prisma, journal } = journalOf();
    await new GeminiVisionProvider(fakeModel(validJson) as any, 'm', journal).extractWineLabel(Buffer.from('x'), 'image/jpeg', 'ENTRY');
    const arr = [{ image: 1, ...validObj() }, { image: 2, ...validObj() }];
    await new GeminiVisionProvider(fakeModel(JSON.stringify(arr)) as any, 'm', journal).extractWineLabels([
      { data: Buffer.from('a'), mimeType: 'image/jpeg' },
      { data: Buffer.from('b'), mimeType: 'image/jpeg' },
    ]);
    await new GeminiVisionProvider(fakeModel('[{"vin":1,"plats":["Agneau"]}]') as any, 'm', journal).suggestPairingsBatch([wine]);
    await new GeminiVisionProvider(fakeModel('[{"domaine":1,"connu":false}]') as any, 'm', journal).describeProducersBatch([{ producer: 'X', appellations: [], region: null }]);
    await new GeminiVisionProvider(fakeModel('{"site": null}') as any, 'm', journal).findOfficialSite({ producer: 'X', cuvee: null, appellation: 'Bandol', vintage: null });
    expect(prisma.calls.map((c: any) => c.usage)).toEqual(['LECTURE_ENTREE', 'LECTURE_ENTREE', 'ACCORDS', 'DESCRIPTIF', 'RECHERCHE_IMAGE']);
  });

  it('503 : noté REFUSE avec le statut, et met Gemini en pause 5 min (« modèle saturé »)', async () => {
    const { prisma, journal } = journalOf();
    await expect(new GeminiVisionProvider(failing(GEMINI_503) as any, 'm', journal).suggestPairingsBatch([wine])).rejects.toBe(GEMINI_503);
    expect(prisma.calls).toEqual([
      { usage: 'ACCORDS', outcome: 'REFUSE', httpStatus: 503, reason: GEMINI_503.message, costCents: 0, durationMs: expect.any(Number) },
    ]);
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe('2026-10-08T12:05:00.000Z');
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('modèle saturé');
  });

  it('429 : noté REFUSE avec le statut, et met Gemini en pause 1 h (« quota épuisé »)', async () => {
    const { prisma, journal } = journalOf();
    await expect(new GeminiVisionProvider(failing(GEMINI_429) as any, 'm', journal).describeProducersBatch([{ producer: 'X', appellations: [], region: null }])).rejects.toBe(GEMINI_429);
    expect(prisma.calls[0]).toMatchObject({ usage: 'DESCRIPTIF', outcome: 'REFUSE', httpStatus: 429 });
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe('2026-10-08T13:00:00.000Z');
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('quota épuisé');
  });

  it('un 503 après un 429 ne raccourcit pas la pause d’une heure', async () => {
    const { prisma, journal } = journalOf();
    prisma.settings.set(GEMINI_PAUSE_UNTIL_KEY, '2026-10-08T11:59:00.000Z'); // pause échue : l'appel part
    await expect(new GeminiVisionProvider(failing(GEMINI_429) as any, 'm', journal).suggestPairingsBatch([wine])).rejects.toBe(GEMINI_429);
    await journal.extendPause(503, NOW);
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe('2026-10-08T13:00:00.000Z');
  });

  it('une autre panne est notée ERREUR, sans pause ; une sortie inexploitable aussi, avec son coût', async () => {
    const { prisma, journal } = journalOf();
    const boom = new Error('[500 Internal Server Error] boom');
    await expect(new GeminiVisionProvider(failing(boom) as any, 'm', journal).suggestPairingsBatch([wine])).rejects.toBe(boom);
    await expect(new GeminiVisionProvider(fakeModel('pas du json') as any, 'm', journal).extractWineLabel(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/sortie du modèle invalide/i);
    await expect(
      new GeminiVisionProvider(fakeModel('pas du json', { promptTokenCount: 200000, candidatesTokenCount: 50000 }) as any, 'm', journal).extractWineLabels([
        { data: Buffer.from('a'), mimeType: 'image/jpeg' },
        { data: Buffer.from('b'), mimeType: 'image/jpeg' },
      ]),
    ).rejects.toThrow(VisionBatchMismatchError);
    expect(prisma.calls.map((c: any) => [c.outcome, c.httpStatus, c.costCents])).toEqual([
      ['ERREUR', 500, 0],
      ['ERREUR', null, 1],
      ['ERREUR', null, 4],
    ]);
    expect(prisma.settings.has(GEMINI_PAUSE_UNTIL_KEY)).toBe(false);
  });

  it('un lot d’accords ou de descriptifs inexploitable porte son coût, déjà facturé, jusque dans le journal', async () => {
    const { prisma, journal } = journalOf();
    const big = { promptTokenCount: 200000, candidatesTokenCount: 50000 };
    const e1 = await new GeminiVisionProvider(fakeModel('pas du json', big) as any, 'm', journal).suggestPairingsBatch([wine]).catch((x) => x);
    expect(e1).toBeInstanceOf(VisionBatchMismatchError);
    expect(e1.costCents).toBe(4);
    const e2 = await new GeminiVisionProvider(fakeModel('{"plats":[]}', big) as any, 'm', journal).suggestPairingsBatch([wine]).catch((x) => x);
    expect(e2).toBeInstanceOf(VisionBatchMismatchError);
    const e3 = await new GeminiVisionProvider(fakeModel('pas du json', big) as any, 'm', journal)
      .describeProducersBatch([{ producer: 'X', appellations: [], region: null }])
      .catch((x) => x);
    expect(e3).toBeInstanceOf(VisionBatchMismatchError);
    expect(prisma.calls.map((c: any) => [c.usage, c.outcome, c.costCents])).toEqual([
      ['ACCORDS', 'ERREUR', 4],
      ['ACCORDS', 'ERREUR', 4],
      ['DESCRIPTIF', 'ERREUR', 4],
    ]);
  });

  it('une seule ligne de journal par lot, quel que soit le nombre de vins ou de domaines, avec le coût total', async () => {
    const { prisma, journal } = journalOf();
    const big = { promptTokenCount: 200000, candidatesTokenCount: 50000 };
    const wines = [wine, { ...wine, producer: 'B' }, { ...wine, producer: 'C' }];
    const plats = JSON.stringify(wines.map((_, i) => ({ vin: i + 1, plats: ['Agneau'] })));
    await new GeminiVisionProvider(fakeModel(plats, big) as any, 'm', journal).suggestPairingsBatch(wines);
    const producers = [{ producer: 'X', appellations: [], region: null }, { producer: 'Y', appellations: [], region: null }];
    await new GeminiVisionProvider(fakeModel('[{"domaine":1,"connu":false},{"domaine":2,"connu":false}]', big) as any, 'm', journal).describeProducersBatch(producers);
    expect(prisma.calls.map((c: any) => [c.usage, c.outcome, c.costCents])).toEqual([
      ['ACCORDS', 'OK', 4],
      ['DESCRIPTIF', 'OK', 4],
    ]);
  });

  it('pendant une pause, aucun appel n’est envoyé à Google et rien n’est noté', async () => {
    const { prisma, journal } = journalOf();
    prisma.settings.set(GEMINI_PAUSE_UNTIL_KEY, '2026-10-08T12:05:00.000Z');
    prisma.settings.set(GEMINI_PAUSE_REASON_KEY, 'modèle saturé');
    const model = fakeModel(validJson);
    const provider = new GeminiVisionProvider(model as any, 'm', journal);
    for (const call of [
      () => provider.extractWineLabel(Buffer.from('x'), 'image/jpeg'),
      () => provider.extractWineLabels([{ data: Buffer.from('a'), mimeType: 'image/jpeg' }]),
      () => provider.suggestPairingsBatch([wine]),
      () => provider.describeProducersBatch([{ producer: 'X', appellations: [], region: null }]),
      () => provider.findOfficialSite({ producer: 'X', cuvee: null, appellation: 'Bandol', vintage: null }),
    ]) {
      const e = await call().catch((x) => x);
      expect(e).toBeInstanceOf(GeminiPausedError);
      expect(e.message).toBe(`Gemini en pause jusqu'à 14:05 (modèle saturé)`);
    }
    expect(model.generateContent).not.toHaveBeenCalled();
    expect(prisma.calls).toEqual([]);
  });

  it('une écriture du journal en échec ne casse pas l’appel', async () => {
    const { prisma, journal } = journalOf();
    prisma.geminiCall.create.mockRejectedValue(new Error('base injoignable'));
    const r = await new GeminiVisionProvider(fakeModel('[{"vin":1,"plats":["Agneau"]}]') as any, 'm', journal).suggestPairingsBatch([wine]);
    expect(r.items).toEqual([{ index: 0, dishes: ['Agneau'] }]);
    await expect(new GeminiVisionProvider(failing(GEMINI_503) as any, 'm', journal).suggestPairingsBatch([wine])).rejects.toBe(GEMINI_503);
  });
});
