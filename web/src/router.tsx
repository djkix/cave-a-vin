import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { CampagneCapturePage } from './pages/CampagneCapturePage';
import { CampagneReviewPage } from './pages/CampagneReviewPage';
import { EntreeCapturePage } from './pages/EntreeCapturePage';
import { EntreeConfirmationPage } from './pages/EntreeConfirmationPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/entree', element: <EntreeCapturePage /> },
      { path: '/entree/campagne', element: <CampagneCapturePage /> },
      { path: '/entree/campagne/revue', element: <CampagneReviewPage /> },
      { path: '/entree/:photoId', element: <EntreeConfirmationPage /> },
    ],
  },
]);
