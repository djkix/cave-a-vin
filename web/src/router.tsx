import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { AdminPage } from './pages/AdminPage';
import { CampagneCapturePage } from './pages/CampagneCapturePage';
import { CampagneReviewPage } from './pages/CampagneReviewPage';
import { CavePage } from './pages/CavePage';
import { EntreeCapturePage } from './pages/EntreeCapturePage';
import { EntreeConfirmationPage } from './pages/EntreeConfirmationPage';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { HomePage } from './pages/HomePage';
import { JournalPage } from './pages/JournalPage';
import { LoginPage } from './pages/LoginPage';
import { WinePage } from './pages/WinePage';

export const router = createBrowserRouter([
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
          { path: '/entree', element: <EntreeCapturePage /> },
          { path: '/entree/campagne', element: <CampagneCapturePage /> },
          { path: '/entree/campagne/revue', element: <CampagneReviewPage /> },
          { path: '/entree/:photoId', element: <EntreeConfirmationPage /> },
          { path: '/journal', element: <JournalPage /> },
          { path: '/cave', element: <CavePage /> },
          { path: '/cave/:wineId', element: <WinePage /> },
          { path: '/admin', element: <AdminPage /> },
          // Derrière RequireAuth : une URL inconnue commence par demander la session,
          // comme n'importe quelle page de l'application.
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
