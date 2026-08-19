const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jojoDesktop', {
  appName: 'jojo-desktop',
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('jojo-desktop:app-info'),
  setFeatureAvailability: (features) => ipcRenderer.send('jojo-desktop:feature-availability', features),
  onNavigate: (callback) => {
    const listener = (_event, path) => callback(path);
    ipcRenderer.on('jojo-desktop:navigate', listener);
    return () => ipcRenderer.removeListener('jojo-desktop:navigate', listener);
  },
  onCloseChoiceRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('jojo-desktop:request-close-choice', listener);
    return () => ipcRenderer.removeListener('jojo-desktop:request-close-choice', listener);
  },
  respondToCloseChoice: (choice) => {
    if (!['tray', 'quit', 'cancel'].includes(choice)) return;
    ipcRenderer.send('jojo-desktop:close-choice', choice);
  },
  settings: {
    getCloseBehavior: () => ipcRenderer.invoke('jojo-settings:close-behavior:get'),
    saveCloseBehavior: (behavior) => ipcRenderer.invoke('jojo-settings:close-behavior:save', behavior),
    getLaunchAtLogin: () => ipcRenderer.invoke('jojo-settings:launch-at-login:get'),
    saveLaunchAtLogin: (enabled) => ipcRenderer.invoke('jojo-settings:launch-at-login:save', enabled)
  }
});
