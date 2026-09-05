import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('edictDesktop', {
  dashboardUrl: () => ipcRenderer.invoke('dashboard:get-url'),
  openDashboard: () => ipcRenderer.invoke('dashboard:show'),
  openModelSettings: () => ipcRenderer.invoke('dashboard:models'),
  onModelSettings: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('dashboard:models', listener)
    return () => ipcRenderer.removeListener('dashboard:models', listener)
  },
  openSettings: (tab?: string) => ipcRenderer.invoke('settings:show', tab),
  onSettingsTab: (callback: (tab: string) => void) => {
    ipcRenderer.on('settings:tab', (_event, tab: string) => callback(tab))
  },
  openMonitor: () => ipcRenderer.invoke('monitor:show'),
  retryDashboard: () => ipcRenderer.invoke('app:retry-dashboard'),
  listProviders: () => ipcRenderer.invoke('provider:list'),
  saveProvider: (payload: unknown) => ipcRenderer.invoke('provider:save', payload),
  removeProvider: (providerId: string) => ipcRenderer.invoke('provider:remove', providerId),
  testProvider: (payload: unknown) => ipcRenderer.invoke('provider:test', payload),
  probeModelThinking: (payload: unknown) => ipcRenderer.invoke('provider:probe-thinking', payload),
  getDiagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  checkRuntime: () => ipcRenderer.invoke('runtime:check'),
  selectRuntimePath: (kind: string) => ipcRenderer.invoke('runtime:select-path', kind),
  saveRuntimePaths: (payload: unknown) => ipcRenderer.invoke('runtime:save-paths', payload),
  reloadDashboard: () => ipcRenderer.invoke('dashboard:reload'),
  setRuntimeOptions: (payload: unknown) => ipcRenderer.invoke('app:set-runtime-options', payload),
  getOpenClawSnapshot: () => ipcRenderer.invoke('openclaw:snapshot'),
  getAgentBindings: () => ipcRenderer.invoke('openclaw:agent-bindings'),
  setAgentModel: (payload: unknown) => ipcRenderer.invoke('openclaw:set-agent-model', payload),
  patchAgent: (payload: unknown) => ipcRenderer.invoke('openclaw:agent-patch', payload),
  patchGlobal: (payload: unknown) => ipcRenderer.invoke('openclaw:global-patch', payload),
  upsertMcp: (payload: unknown) => ipcRenderer.invoke('openclaw:mcp-upsert', payload),
  removeMcp: (name: string) => ipcRenderer.invoke('openclaw:mcp-remove', name),
  reloadMcp: () => ipcRenderer.invoke('openclaw:mcp-reload'),
  probeMcp: (name: string) => ipcRenderer.invoke('openclaw:mcp-probe', name),
  dashboardApi: (payload: unknown) => ipcRenderer.invoke('dashboard:api', payload),
  getObservability: (options?: unknown) => ipcRenderer.invoke('dashboard:observability', options),
})
