import { useCallback, useEffect, useMemo, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { CloseChoiceDialog, type CloseChoice } from './CloseChoiceDialog';
import { createDesktopRouter } from './router';
import { UpdateNotice } from './UpdateNotice';

export default function DesktopApp() {
  const router = useMemo(() => createDesktopRouter(), []);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  useEffect(
    () => window.jojoDesktop?.onNavigate?.((path) => {
      void router.navigate(path);
    }),
    [router],
  );
  useEffect(
    () => window.jojoDesktop?.onCloseChoiceRequested?.(() => setCloseChoiceOpen(true)),
    [],
  );
  const chooseClose = useCallback((choice: CloseChoice) => {
    setCloseChoiceOpen(false);
    window.jojoDesktop?.respondToCloseChoice?.(choice);
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <CloseChoiceDialog open={closeChoiceOpen} onChoose={chooseClose} />
      <UpdateNotice />
    </>
  );
}
