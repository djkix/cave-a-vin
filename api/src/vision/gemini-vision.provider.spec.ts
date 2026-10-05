import { GeminiVisionProvider } from './gemini-vision.provider';
import { PairingInvalidOutputError } from './pairing-output';

const validJson = JSON.stringify({
  producteur: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: null, confidence: 0 },
  appellation: { value: 'Bandol', confidence: 0.97 }, millesime: { value: 2019, confidence: 0.94 },
  couleur: { value: 'rouge', confidence: 0.99 }, format_cl: { value: 75, confidence: 0.9 },
  degre: { value: null, confidence: 0 }, pays_region: { value: 'Provence', confidence: 0.7 },
  nb_cols_carton: { value: 6, confidence: 0.85 }, confiance_globale: 0.93,
});

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
