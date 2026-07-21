import { useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './router';

function getHashInitialEntry() {
  if (window.location.protocol !== 'file:' || !window.location.hash.startsWith('#')) {
    return null;
  }

  return window.location.hash.slice(1) || '/';
}

export default function App() {
  const router = useMemo(() => {
    const hashInitialEntry = getHashInitialEntry();
    return hashInitialEntry ? createAppRouter({ initialEntries: [hashInitialEntry] }) : createAppRouter();
  }, []);

  return <RouterProvider router={router} />;
}
