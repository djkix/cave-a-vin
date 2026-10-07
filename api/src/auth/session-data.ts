import 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** Cave courante choisie par le compte (voir CaveContextService.resolveCurrent). */
    caveId?: string;
  }
}
