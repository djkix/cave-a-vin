import { createBrowserRouter, Navigate, RouteObject } from 'react-router-dom';
import { RequireAuth, RequireOwner } from './components/RequireAuth';
import { ABoirePage } from './pages/ABoirePage';
import { AdminPage } from './pages/AdminPage';
import { AConfirmerPage } from './pages/AConfirmerPage';
import { CavePage } from './pages/CavePage';
import { ComptePage } from './pages/ComptePage';
import { EntreeCapturePage } from './pages/EntreeCapturePage';
import { EntreeConfirmationPage } from './pages/EntreeConfirmationPage';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { HomePage } from './pages/HomePage';
import { JournalPage } from './pages/JournalPage';
import { LoginPage } from './pages/LoginPage';
import { MaCavePage } from './pages/MaCavePage';
import { SortieCapturePage } from './pages/SortieCapturePage';
import { SortieResolutionPage } from './pages/SortieResolutionPage';
import { StatsPage } from './pages/StatsPage';
import { WinePage } from './pages/WinePage';

export const routes: RouteObject[] = [
  {
    // Route racine sans chemin : elle ne sert qu'à porter l'errorElement, pour que
    // toute exception de rendu affiche un message en français au lieu de l'écran
    // de secours de React Router.
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/stats', element: <StatsPage /> },
          { path: '/compte', element: <ComptePage /> },
          { path: '/a-boire', element: <ABoirePage /> },
          { path: '/cave', element: <CavePage /> },
          { path: '/cave/:wineId', element: <WinePage /> },
          {
            // Réservé au propriétaire de la cave courante : un membre en lecture
            // seule qui y arrive (lien direct, changement de cave) revient à l'accueil.
            element: <RequireOwner />,
            children: [
              { path: '/entree', element: <EntreeCapturePage /> },
              // Anciennes adresses du mode campagne, remplacé par la rafale et « À confirmer ».
              { path: '/entree/campagne', element: <Navigate to="/entree" replace /> },
              { path: '/entree/campagne/revue', element: <Navigate to="/a-confirmer" replace /> },
              { path: '/a-confirmer', element: <AConfirmerPage /> },
              { path: '/entree/:photoId', element: <EntreeConfirmationPage /> },
              { path: '/journal', element: <JournalPage /> },
              { path: '/sortie', element: <SortieCapturePage /> },
              { path: '/sortie/:photoId', element: <SortieResolutionPage /> },
              { path: '/ma-cave', element: <MaCavePage /> },
              // Ancienne adresse de l'écran des membres, désormais dans « Ma cave ».
              { path: '/membres', element: <Navigate to="/ma-cave" replace /> },
            ],
          },
          { path: '/admin', element: <AdminPage /> },
          // Derrière RequireAuth : une URL inconnue commence par demander la session,
          // comme n'importe quelle page de l'application.
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
