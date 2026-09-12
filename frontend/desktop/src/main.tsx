import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './shell/App';
import '@jojo/web/desktop.css';
import './shell/styles.css';
import { analytics } from '@jojo/analytics';

void import('@jojo/analytics/browser').then(({ initializeBrowserAnalytics }) => initializeBrowserAnalytics({
  token: import.meta.env.VITE_POSTHOG_TOKEN,
  host: import.meta.env.VITE_POSTHOG_HOST,
  production: import.meta.env.PROD && Boolean(window.jojoDesktop),
  context: { client: 'desktop', platform: window.jojoDesktop?.platform || 'unknown',
    app_variant: 'standard', app_version: import.meta.env.VITE_APP_VERSION || 'unknown', release_channel: 'stable' },
})).catch(() => undefined);

document.documentElement.dataset.desktopPlatform = window.jojoDesktop?.platform ?? 'web';

ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: (error) => { console.error(error); analytics.exception(error, 'react'); },
  onUncaughtError: (error) => { console.error(error); analytics.exception(error, 'react'); },
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
