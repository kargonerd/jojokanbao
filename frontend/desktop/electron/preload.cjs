const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jojoDesktop', {
  appName: 'jojo-desktop',
  selectPdf: () => ipcRenderer.invoke('jojo-desktop:select-pdf'),
  onNavigate: (callback) => {
    const listener = (_event, path) => callback(path);
    ipcRenderer.on('jojo-desktop:navigate', listener);
    return () => ipcRenderer.removeListener('jojo-desktop:navigate', listener);
  },
  settings: {
    getMineru: () => ipcRenderer.invoke('jojo-settings:mineru:get'),
    saveMineru: (token) => ipcRenderer.invoke('jojo-settings:mineru:save', token)
  },
  engine: {
    invoke: (command, payload) => ipcRenderer.invoke('jojo-engine:invoke', command, payload)
  }
});
