import { useEffect, useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import { createDesktopRouter } from './router';

export default function DesktopApp() {
  const router = useMemo(() => createDesktopRouter(), []);
  useEffect(
    () => window.jojoDesktop?.onNavigate?.((path) => {
      void router.navigate(path);
    }),
    [router],
  );
  return <RouterProvider router={router} />;
}
