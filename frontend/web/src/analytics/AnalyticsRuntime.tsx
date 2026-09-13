import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { analytics, screenForPath } from "@jojo/analytics";
import { useAccountSessionStore } from "../account/session";

export function AnalyticsRuntime() {
  const { pathname } = useLocation();
  const { initialized, userId, analyticsExcluded } = useAccountSessionStore();
  useEffect(() => {
    analytics.setIdentity({ initialized, userId, excluded: analyticsExcluded });
    if (initialized) analytics.screen(screenForPath(pathname));
  }, [initialized, userId, analyticsExcluded, pathname]);
  return null;
}
