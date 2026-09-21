/**
 * Version affichée dans la barre de titre, sur tous les écrans.
 *
 * La valeur est injectée à la construction de l'image par l'intégration continue
 * (`VITE_APP_VERSION`, voir .github/workflows/docker-build.yml) : le numéro de
 * version publié pour une image taguée, et ce même numéro suivi de l'empreinte du
 * commit pour une image `latest` construite depuis `main`. Une construction locale
 * sans variable affiche « dev ».
 */
export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || 'dev';
