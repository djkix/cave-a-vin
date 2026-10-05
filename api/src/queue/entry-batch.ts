/** Nombre maximal de photos d'entrée envoyées à Gemini en un seul appel. */
export const ENTRY_BATCH_SIZE = 8;

/** Au-delà de cette attente, la plus ancienne photo part même si le lot est incomplet. */
export const ENTRY_BATCH_MAX_WAIT_MS = 45_000;

/** Intervalle entre deux passages du worker. */
export const ENTRY_BATCH_TICK_MS = 15_000;

/**
 * Échéance d'une réservation : une photo restée `PROCESSING` au-delà (worker
 * arrêté en plein lot) est remise en attente au passage suivant.
 */
export const RESERVATION_MS = 5 * 60_000;

/** Nombre de candidates lues pour décider s'il faut lancer un lot. */
export const ENTRY_CANDIDATES_SCAN = 50;

export interface EntryCandidate {
  createdAt: Date;
  nextAttemptAt: Date | null;
}

/**
 * Un lot part quand il est plein, quand la plus ancienne photo attend depuis
 * 45 s, ou quand une photo reportée arrive à son heure de reprise : regrouper
 * économise des appels, mais jamais au prix d'une attente sans fin.
 */
export function shouldRun(candidates: EntryCandidate[], now: Date): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length >= ENTRY_BATCH_SIZE) return true;
  const t = now.getTime();
  const oldest = Math.min(...candidates.map((c) => c.createdAt.getTime()));
  if (oldest <= t - ENTRY_BATCH_MAX_WAIT_MS) return true;
  return candidates.some((c) => c.nextAttemptAt !== null && c.nextAttemptAt.getTime() <= t);
}

/** Coût d'un appel réparti sur ses photos, arrondi au centime supérieur. */
export function splitCost(total: number, n: number): number {
  return Math.ceil(total / n);
}

/**
 * Boucle du worker : un passage au démarrage, puis un toutes les `intervalMs`,
 * jamais deux à la fois — un passage encore en cours (appel Gemini lent) fait
 * simplement sauter le suivant. `stop` arrête l'horloge et attend le passage en
 * cours, pour ne pas fermer la base sous ses pieds.
 */
export function createEntryBatchLoop(
  tick: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): { start(): void; stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const run = () => {
    if (running || stopped) return;
    running = tick()
      .then(
        () => undefined,
        (e) => onError(e),
      )
      .finally(() => {
        running = null;
      });
  };

  return {
    start() {
      run();
      timer = setInterval(run, intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
  };
}
