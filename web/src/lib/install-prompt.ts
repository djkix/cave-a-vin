import { useEffect, useState } from 'react';

/** Événement non standard de Chrome / Edge / Android : propose l'installation de la PWA. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// L'événement arrive tôt, souvent avant l'affichage de la page « Mon compte » :
// il est gardé ici dès le chargement de l'application (import dans main.tsx).
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function listenForInstallPrompt(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export type InstallState =
  /** Déjà ouverte comme application installée. */
  | 'installed'
  /** Le navigateur propose l'installation : un bouton suffit. */
  | 'prompt'
  /** iPhone / iPad : seule voie, Safari › Partager › « Sur l'écran d'accueil ». */
  | 'ios'
  /** Autre navigateur : passer par son menu. */
  | 'manual';

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// L'iPad récent se présente comme un Mac tactile ; un Android ne l'est jamais.
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (!/android/i.test(navigator.userAgent) && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function installState(): InstallState {
  if (isStandalone()) return 'installed';
  if (deferred) return 'prompt';
  return isIos() ? 'ios' : 'manual';
}

/** État d'installation, et `install()` qui ouvre la fenêtre du navigateur quand il la propose. */
export function useInstallPrompt() {
  const [state, setState] = useState<InstallState>(installState);
  useEffect(() => {
    const update = () => setState(installState());
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  async function install() {
    if (!deferred) return;
    const event = deferred;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // L'événement ne sert qu'une fois ; accepté, l'application est installée.
    deferred = null;
    setState(outcome === 'accepted' ? 'installed' : installState());
  }
  return { state, install };
}
