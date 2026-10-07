import { GeminiVisionProvider, VisionBatchMismatchError } from './gemini-vision.provider';
import { PairingInvalidOutputError } from './pairing-output';
import { ProducerInvalidOutputError } from './producer-output';

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

describe('GeminiVisionProvider.suggestPairings', () => {
  const wine = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019 };
  const fake = (text: string, usage = { promptTokenCount: 200, candidatesTokenCount: 50 }) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => text, usageMetadata: usage } })),
  });

  it('demande des plats en français pour ce vin et rend la liste vérifiée avec un coût arrondi (quasi nul pour un appel courant)', async () => {
    const model = fake('{"plats":["Agneau de sept heures","Daube provençale"]}');
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairings(wine);
    expect(r).toEqual({ dishes: ['Agneau de sept heures', 'Daube provençale'], model: 'gemini-test', costCents: 0 });
    const prompt = (model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text as string;
    expect(prompt).toContain('Domaine Tempier');
    expect(prompt).toContain('La Tourtine');
    expect(prompt).toContain('Bandol');
    expect(prompt).toContain('2019');
  });

  it('arrondit (ne majore jamais) le coût d’un accord, contrairement à l’analyse de photo', async () => {
    const model = fake('{"plats":["Agneau"]}', { promptTokenCount: 200000, candidatesTokenCount: 50000 });
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairings(wine);
    expect(r.costCents).toBe(4);
  });

  it('nomme un vin non millésimé comme tel', async () => {
    const model = fake('{"plats":["Comté"]}');
    await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairings({ ...wine, vintage: null });
    expect((model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text).toContain('non millésimé');
  });

  it('refuse un JSON illisible', async () => {
    await expect(new GeminiVisionProvider(fake('pas du json') as any, 'm').suggestPairings(wine)).rejects.toThrow(PairingInvalidOutputError);
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

describe('GeminiVisionProvider.describeProducer', () => {
  const query = { producer: 'Domaine Tempier', appellations: ['Bandol'], region: 'Provence' };
  const description = 'Domaine familial du Castellet, au cœur de l’appellation Bandol, réputé pour ses mourvèdres de garde.';
  const fake = (body: string, usage = { promptTokenCount: 200, candidatesTokenCount: 120 }) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => body, usageMetadata: usage } })),
  });
  const promptOf = (model: ReturnType<typeof fake>) => (model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text as string;

  it('demande un descriptif en français et rend le texte vérifié avec un coût arrondi', async () => {
    const model = fake(JSON.stringify({ connu: true, description }));
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').describeProducer(query);
    expect(r).toEqual({ known: true, description, model: 'gemini-test', costCents: 0 });
    const prompt = promptOf(model);
    expect(prompt).toContain('Domaine Tempier');
    expect(prompt).toContain('Bandol');
    expect(prompt).toContain('Provence');
    expect(prompt).toContain('{"connu": false}');
    expect(prompt).toMatch(/3 à 4 phrases/);
    expect((model.generateContent.mock.calls[0] as any)[0].generationConfig.responseMimeType).toBe('application/json');
  });

  it('rend « inconnu » sans texte pour un domaine peu documenté', async () => {
    const r = await new GeminiVisionProvider(fake('{"connu": false}') as any, 'gemini-test').describeProducer(query);
    expect(r).toEqual({ known: false, description: null, model: 'gemini-test', costCents: 0 });
  });

  it('arrondit (ne majore jamais) le coût, comme pour les accords', async () => {
    const model = fake(JSON.stringify({ connu: true, description }), { promptTokenCount: 200000, candidatesTokenCount: 50000 });
    expect((await new GeminiVisionProvider(model as any, 'm').describeProducer(query)).costCents).toBe(4);
  });

  it('accepte un JSON entouré d’une clôture ```json', async () => {
    const model = fake('```json\n' + JSON.stringify({ connu: true, description }) + '\n```');
    await expect(new GeminiVisionProvider(model as any, 'm').describeProducer(query)).resolves.toMatchObject({ known: true });
  });

  it('refuse un JSON illisible', async () => {
    await expect(new GeminiVisionProvider(fake('pas du json') as any, 'm').describeProducer(query)).rejects.toThrow(ProducerInvalidOutputError);
  });

  it('refuse un descriptif trop court', async () => {
    await expect(new GeminiVisionProvider(fake('{"connu": true, "description": "Bandol."}') as any, 'm').describeProducer(query))
      .rejects.toThrow(/Sortie du modèle invalide/);
  });

  it('nomme une région et des appellations inconnues comme telles', async () => {
    const model = fake('{"connu": false}');
    await new GeminiVisionProvider(model as any, 'm').describeProducer({ producer: 'Clos X', appellations: [], region: null });
    expect(promptOf(model)).toContain('inconnue');
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
