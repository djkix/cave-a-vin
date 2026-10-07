import { CaveBudgetShareExceededError, PAIRING_BUDGET_SHARE, VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

describe('VisionBudgetService', () => {
  const prismaWith = (sum: number | null, pairingSum: number | null = null, producerSum: number | null = null, imageSearchSum: number | null = null) => ({
    photo: { aggregate: async () => ({ _sum: { costCents: sum } }) },
    pairing: { aggregate: jest.fn(async () => ({ _sum: { costCents: pairingSum } })) },
    producerProfile: { aggregate: jest.fn(async () => ({ _sum: { costCents: producerSum } })) },
    imageSearchCost: { aggregate: jest.fn(async () => ({ _sum: { costCents: imageSearchSum } })) },
  });

  it('passes when under the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(120) as any, 500).assertUnderCap()).resolves.toBeUndefined();
  });

  it('throws when the monthly sum reaches the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderCap()).rejects.toBeInstanceOf(VisionBudgetExceededError);
  });

  it('additionne les photos et les accords du mois', async () => {
    const prisma = prismaWith(30, 12);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(42);
    expect(prisma.pairing.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { generatedAt: { gte: expect.any(Date) } } });
  });

  it('compte aussi les descriptifs de domaine générés dans le mois', async () => {
    const prisma = prismaWith(30, 12, 5);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(47);
    expect(prisma.producerProfile.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { generatedAt: { gte: expect.any(Date) } } });
  });

  it('compte aussi les recherches d’image du mois (site officiel trouvé par Gemini)', async () => {
    const prisma = prismaWith(30, 12, 5, 3);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(50);
    expect(prisma.imageSearchCost.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { createdAt: { gte: expect.any(Date) } } });
  });

  describe('assertUnderShare', () => {
    it('passe sous 80 % du plafond (79 %)', async () => {
      await expect(new VisionBudgetService(prismaWith(395) as any, 500).assertUnderShare(PAIRING_BUDGET_SHARE)).resolves.toBeUndefined();
    });

    it('lève une erreur à 80 % du plafond, pour garder de la marge aux photos', async () => {
      await expect(new VisionBudgetService(prismaWith(400) as any, 500).assertUnderShare(PAIRING_BUDGET_SHARE)).rejects.toBeInstanceOf(VisionBudgetExceededError);
    });

    it('assertUnderCap reste équivalent à une part de 100 %', async () => {
      await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderShare(1)).rejects.toBeInstanceOf(VisionBudgetExceededError);
      await expect(new VisionBudgetService(prismaWith(499) as any, 500).assertUnderShare(1)).resolves.toBeUndefined();
    });
  });
});

describe('VisionBudgetService — part par cave', () => {
  const CAVE = 'cave-1';
  const EXEMPT = 'cave-franck';
  /** Faux Prisma : dépenses du mois de la cave, réglage, premier administrateur et sa cave. */
  const fake = (opts: {
    photos?: number | null;
    pairings?: number | null;
    imageSearches?: number | null;
    setting?: string | null;
    firstAdmin?: { id: string } | null;
    adminCave?: { id: string } | null;
  }) => ({
    photo: { aggregate: jest.fn(async () => ({ _sum: { costCents: opts.photos ?? null } })) },
    pairing: { aggregate: jest.fn(async () => ({ _sum: { costCents: opts.pairings ?? null } })) },
    producerProfile: { aggregate: jest.fn(async () => ({ _sum: { costCents: 999 } })) },
    imageSearchCost: { aggregate: jest.fn(async () => ({ _sum: { costCents: opts.imageSearches ?? null } })) },
    appSetting: {
      findUnique: jest.fn(async () => (opts.setting === undefined || opts.setting === null ? null : { key: 'cave_budget_share', value: opts.setting })),
      upsert: jest.fn(async (args: any) => ({ key: 'cave_budget_share', value: args.update.value })),
    },
    appUser: { findFirst: jest.fn(async () => (opts.firstAdmin === undefined ? { id: 'franck' } : opts.firstAdmin)) },
    cave: { findFirst: jest.fn(async () => (opts.adminCave === undefined ? { id: EXEMPT } : opts.adminCave)) },
  });

  describe('spentThisMonthCents(caveId)', () => {
    it('ne compte que les photos, accords (par le vin) et recherches d’image de la cave, jamais les descriptifs', async () => {
      const prisma = fake({ photos: 30, pairings: 12, imageSearches: 3 });
      await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents(CAVE)).resolves.toBe(45);
      expect(prisma.photo.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { createdAt: { gte: expect.any(Date) }, caveId: CAVE } });
      expect(prisma.pairing.aggregate).toHaveBeenCalledWith({
        _sum: { costCents: true },
        where: { generatedAt: { gte: expect.any(Date) }, wine: { caveId: CAVE } },
      });
      expect(prisma.imageSearchCost.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { createdAt: { gte: expect.any(Date) }, caveId: CAVE } });
      expect(prisma.producerProfile.aggregate).not.toHaveBeenCalled();
    });

    it('sans cave : toute la dépense, descriptifs compris (inchangé)', async () => {
      const prisma = fake({ photos: 30, pairings: 12, imageSearches: 3 });
      await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(30 + 12 + 999 + 3);
    });
  });

  describe('caveShare', () => {
    it('lit app_setting.cave_budget_share', async () => {
      const prisma = fake({ setting: '0.35' });
      await expect(new VisionBudgetService(prisma as any, 500).caveShare()).resolves.toBe(0.35);
      expect(prisma.appSetting.findUnique).toHaveBeenCalledWith({ where: { key: 'cave_budget_share' } });
    });

    it('réglage absent : 0,2', async () => {
      await expect(new VisionBudgetService(fake({ setting: null }) as any, 500).caveShare()).resolves.toBe(0.2);
    });

    it('réglage illisible ou hors bornes : 0,2', async () => {
      for (const setting of ['abc', '', '1.5', '-0.1']) {
        await expect(new VisionBudgetService(fake({ setting }) as any, 500).caveShare()).resolves.toBe(0.2);
      }
    });

    it('setCaveShare enregistre la part', async () => {
      const prisma = fake({});
      await new VisionBudgetService(prisma as any, 500).setCaveShare(0.5);
      expect(prisma.appSetting.upsert).toHaveBeenCalledWith({
        where: { key: 'cave_budget_share' },
        create: { key: 'cave_budget_share', value: '0.5' },
        update: { value: '0.5' },
      });
    });
  });

  describe('exemptCaveId', () => {
    it('cave du plus ancien administrateur actif hors compte de secours', async () => {
      const prisma = fake({});
      await expect(new VisionBudgetService(prisma as any, 500).exemptCaveId()).resolves.toBe(EXEMPT);
      expect(prisma.appUser.findFirst).toHaveBeenCalledWith({
        where: { isAdmin: true, isBreakGlass: false, status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      expect(prisma.cave.findFirst).toHaveBeenCalledWith({
        where: { ownerId: 'franck' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
    });

    it('aucun administrateur : aucune cave exemptée', async () => {
      const prisma = fake({ firstAdmin: null });
      await expect(new VisionBudgetService(prisma as any, 500).exemptCaveId()).resolves.toBeNull();
      expect(prisma.cave.findFirst).not.toHaveBeenCalled();
    });

    it('premier administrateur sans cave : aucune cave exemptée', async () => {
      await expect(new VisionBudgetService(fake({ adminCave: null }) as any, 500).exemptCaveId()).resolves.toBeNull();
    });
  });

  describe('assertCaveUnderShare', () => {
    it('passe sous plafond × part (500 × 0,2 = 100 ; 99 dépensés)', async () => {
      await expect(new VisionBudgetService(fake({ photos: 99 }) as any, 500).assertCaveUnderShare(CAVE)).resolves.toBeUndefined();
    });

    it('reporte à plafond × part atteint, avec le message de la cave', async () => {
      const p = new VisionBudgetService(fake({ photos: 60, pairings: 30, imageSearches: 10 }) as any, 500).assertCaveUnderShare(CAVE);
      await expect(p).rejects.toBeInstanceOf(CaveBudgetShareExceededError);
      await expect(
        new VisionBudgetService(fake({ photos: 100 }) as any, 500).assertCaveUnderShare(CAVE),
      ).rejects.toThrow('Part mensuelle de cette cave atteinte — reprise le mois prochain');
    });

    it('est un report de plafond : même type d’erreur que le plafond global', async () => {
      await expect(new VisionBudgetService(fake({ photos: 100 }) as any, 500).assertCaveUnderShare(CAVE)).rejects.toBeInstanceOf(
        VisionBudgetExceededError,
      );
    });

    it('suit le réglage (0,5 → 250)', async () => {
      await expect(new VisionBudgetService(fake({ photos: 249, setting: '0.5' }) as any, 500).assertCaveUnderShare(CAVE)).resolves.toBeUndefined();
      await expect(new VisionBudgetService(fake({ photos: 250, setting: '0.5' }) as any, 500).assertCaveUnderShare(CAVE)).rejects.toBeInstanceOf(
        CaveBudgetShareExceededError,
      );
    });

    it('réglage absent : part de 0,2', async () => {
      await expect(new VisionBudgetService(fake({ photos: 100, setting: null }) as any, 500).assertCaveUnderShare(CAVE)).rejects.toBeInstanceOf(
        CaveBudgetShareExceededError,
      );
    });

    it('la cave du premier administrateur est exemptée, sans même compter sa dépense', async () => {
      const prisma = fake({ photos: 10_000 });
      await expect(new VisionBudgetService(prisma as any, 500).assertCaveUnderShare(EXEMPT)).resolves.toBeUndefined();
      expect(prisma.photo.aggregate).not.toHaveBeenCalled();
    });

    describe('ensemble des caves invitées', () => {
      /** La cave a dépensé 50 ; toutes les caves invitées ensemble, `invited`. */
      const withInvited = (invited: number, setting: string | null = null) => {
        const prisma: any = fake({ setting });
        const byFilter = jest.fn(async (args: any) => {
          const filter = args.where.caveId ?? args.where.wine?.caveId;
          return { _sum: { costCents: typeof filter === 'object' ? invited : 50 } };
        });
        prisma.photo.aggregate = byFilter;
        prisma.pairing.aggregate = jest.fn(async () => ({ _sum: { costCents: 0 } }));
        prisma.imageSearchCost.aggregate = jest.fn(async () => ({ _sum: { costCents: 0 } }));
        return { prisma, byFilter };
      };

      it('reporte quand les caves invitées ont atteint plafond × 0,6, même sous la part de la cave', async () => {
        const { prisma, byFilter } = withInvited(300);
        await expect(new VisionBudgetService(prisma as any, 500).assertCaveUnderShare(CAVE)).rejects.toThrow(
          'Part mensuelle des caves invitées atteinte — reprise le mois prochain',
        );
        expect(byFilter).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ caveId: { not: EXEMPT } }) }));
      });

      it('passe juste en dessous, et suit le réglage', async () => {
        await expect(new VisionBudgetService(withInvited(299).prisma as any, 500).assertCaveUnderShare(CAVE)).resolves.toBeUndefined();
        await expect(new VisionBudgetService(withInvited(299, '0.5').prisma as any, 500).assertCaveUnderShare(CAVE)).rejects.toBeInstanceOf(
          CaveBudgetShareExceededError,
        );
      });

      it('la cave principale n’y est jamais soumise', async () => {
        await expect(new VisionBudgetService(withInvited(10_000).prisma as any, 500).assertCaveUnderShare(EXEMPT)).resolves.toBeUndefined();
      });
    });

    it('sans premier administrateur, aucune cave n’est exemptée', async () => {
      await expect(
        new VisionBudgetService(fake({ photos: 100, firstAdmin: null }) as any, 500).assertCaveUnderShare(EXEMPT),
      ).rejects.toBeInstanceOf(CaveBudgetShareExceededError);
    });
  });
});
