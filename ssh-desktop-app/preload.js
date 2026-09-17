const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  send: (channel, data) => {
    const validChannels = ['minimize-window', 'maximize-window', 'close-window'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, func) => {
    const validChannels = ['window-state'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  }
});

contextBridge.exposeInMainWorld('sshAPI', {
  connect: (opts) => ipcRenderer.invoke('ssh:connect', opts),
  write: (connId, data) => ipcRenderer.send('ssh:write', { connId, data }),
  resize: (connId, cols, rows) => ipcRenderer.send('ssh:resize', { connId, cols, rows }),
  disconnect: (connId) => ipcRenderer.send('ssh:disconnect', { connId }),
  hostKeyDecision: (promptId, accept) => ipcRenderer.send('ssh:host-key-decision', { promptId, accept }),
  selectKeyFile: () => ipcRenderer.invoke('dialog:select-key-file'),
  testTcp: (host, port) => ipcRenderer.invoke('net:test-tcp', { host, port }),
  stats: (connId) => ipcRenderer.invoke('ssh:stats', { connId }),

  onProgress: (cb) => ipcRenderer.on('ssh:progress', (event, payload) => cb(payload)),
  onLog: (cb) => ipcRenderer.on('ssh:log', (event, payload) => cb(payload)),
  onData: (cb) => ipcRenderer.on('ssh:data', (event, payload) => cb(payload)),
  onClosed: (cb) => ipcRenderer.on('ssh:closed', (event, payload) => cb(payload)),
  onHostKeyPrompt: (cb) => ipcRenderer.on('ssh:host-key-prompt', (event, payload) => cb(payload)),
  onOsDetected: (cb) => ipcRenderer.on('ssh:os', (event, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('vaultAPI', {
  status: () => ipcRenderer.invoke('vault:status'),
  create: (password) => ipcRenderer.invoke('vault:create', { password }),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', { password }),
  save: (data) => ipcRenderer.invoke('vault:save', { data }),
  lock: () => ipcRenderer.invoke('vault:lock'),
  changePassword: (oldPassword, newPassword) => ipcRenderer.invoke('vault:change-password', { oldPassword, newPassword }),
  backup: () => ipcRenderer.invoke('vault:backup'),
  setLocation: (store, pick) => ipcRenderer.invoke('vault:set-location', { store, pick }),
  onFlushRequest: (cb) => ipcRenderer.on('app:flush', async () => {
    try { await cb(); } finally { ipcRenderer.send('app:flushed'); }
  }),
});

contextBridge.exposeInMainWorld('agentAPI', {
  detect: (force) => ipcRenderer.invoke('agent:detect', { force }),
  start: (connId, profileId, fresh) => ipcRenderer.invoke('agent:start', { connId, profileId, fresh }),
  forget: (profileId) => ipcRenderer.invoke('agent:forget', { profileId }),
  loadTranscript: (profileId) => ipcRenderer.invoke('agent:load-transcript', { profileId }),
  saveTranscript: (profileId, items) => ipcRenderer.invoke('agent:save-transcript', { profileId, items }),
  prompt: (chatId, content) => ipcRenderer.invoke('agent:prompt', { chatId, content }),
  cancel: (chatId) => ipcRenderer.invoke('agent:cancel', { chatId }),
  close: (chatId) => ipcRenderer.invoke('agent:close', { chatId }),
  approve: (approvalId, allow, always) => ipcRenderer.send('agent:approval-decision', { approvalId, allow, always }),
  choosePermission: (requestId, optionId) => ipcRenderer.send('agent:permission-decision', { requestId, optionId }),
  onStatus: (cb) => ipcRenderer.on('agent:status', (event, p) => cb(p)),
  onUpdate: (cb) => ipcRenderer.on('agent:update', (event, p) => cb(p)),
  onStop: (cb) => ipcRenderer.on('agent:stop', (event, p) => cb(p)),
  onApproval: (cb) => ipcRenderer.on('agent:approval', (event, p) => cb(p)),
  onApprovalClosed: (cb) => ipcRenderer.on('agent:approval-closed', (event, p) => cb(p)),
  onPermission: (cb) => ipcRenderer.on('agent:permission', (event, p) => cb(p)),
  onAction: (cb) => ipcRenderer.on('agent:action', (event, p) => cb(p)),
});

contextBridge.exposeInMainWorld('sftpAPI', {
  home: (connId) => ipcRenderer.invoke('sftp:home', { connId }),
  list: (connId, dir) => ipcRenderer.invoke('sftp:list', { connId, dir }),
  mkdir: (connId, dir) => ipcRenderer.invoke('sftp:mkdir', { connId, dir }),
  rename: (connId, from, to) => ipcRenderer.invoke('sftp:rename', { connId, from, to }),
  remove: (connId, paths) => ipcRenderer.invoke('sftp:delete', { connId, paths }),
  pickUpload: (folders) => ipcRenderer.invoke('sftp:pick-upload', { folders }),
  pickDownloadDir: () => ipcRenderer.invoke('sftp:pick-download-dir'),
  download: (connId, paths, localDir) => ipcRenderer.invoke('sftp:download', { connId, paths, localDir }),
  upload: (connId, localPaths, remoteDir, skipNames) => ipcRenderer.invoke('sftp:upload', { connId, localPaths, remoteDir, skipNames }),
  cancel: (jobId) => ipcRenderer.send('sftp:cancel', { jobId }),
  showLocal: (file) => ipcRenderer.send('sftp:show-local', { file }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTransfer: (cb) => ipcRenderer.on('sftp:transfer', (event, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('tunnelAPI', {
  start: (opts) => ipcRenderer.invoke('tunnel:start', opts),
  stop: (tunnelId) => ipcRenderer.invoke('tunnel:stop', { tunnelId }),
  list: () => ipcRenderer.invoke('tunnel:list'),
  onStopped: (cb) => ipcRenderer.on('tunnel:stopped', (event, payload) => cb(payload)),
  onActivity: (cb) => ipcRenderer.on('tunnel:activity', (event, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('tunnel:error', (event, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('localAPI', {
  shells: () => ipcRenderer.invoke('local:shells'),
  spawn: (opts) => ipcRenderer.invoke('local:spawn', opts),
  write: (ptyId, data) => ipcRenderer.send('local:write', { ptyId, data }),
  resize: (ptyId, cols, rows) => ipcRenderer.send('local:resize', { ptyId, cols, rows }),
  kill: (ptyId) => ipcRenderer.send('local:kill', { ptyId }),
  pickDir: (current) => ipcRenderer.invoke('local:pick-dir', { current }),
  onData: (cb) => ipcRenderer.on('local:data', (event, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('local:exit', (event, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('appAPI', {
  about: () => ipcRenderer.invoke('app:about'),
  tempInfo: () => ipcRenderer.invoke('app:temp-info'),
  clearTemp: () => ipcRenderer.invoke('app:clear-temp'),
  reportError: (source, message, stack) => ipcRenderer.send('errors:report', { source, message, stack }),
  listErrors: () => ipcRenderer.invoke('errors:list'),
  clearErrors: () => ipcRenderer.invoke('errors:clear'),
  onError: (cb) => ipcRenderer.on('errors:new', (event, entry) => cb(entry)),
  exportJournal: (name, text) => ipcRenderer.invoke('journal:export', { name, text }),
});

contextBridge.exposeInMainWorld('syncAPI', {
  status: () => ipcRenderer.invoke('sync:status'),
  login: () => ipcRenderer.invoke('sync:login'),
  cancelLogin: () => ipcRenderer.invoke('sync:cancel-login'),
  logout: (deleteRemote) => ipcRenderer.invoke('sync:logout', { deleteRemote }),
  now: () => ipcRenderer.invoke('sync:now'),
  setAuto: (auto) => ipcRenderer.invoke('sync:set-auto', { auto }),
  password: (password) => ipcRenderer.invoke('sync:password', { password }),
  skipPassword: () => ipcRenderer.invoke('sync:skip-password'),
  restore: () => ipcRenderer.invoke('sync:restore'),
  openDrive: () => ipcRenderer.invoke('sync:open-drive'),
  merged: (id, ok, error) => ipcRenderer.send('sync:merged', { id, ok, error }),
  onState: (cb) => ipcRenderer.on('sync:state', (event, s) => cb(s)),
  onRemote: (cb) => ipcRenderer.on('sync:remote', (event, p) => cb(p)),
  onNeedPassword: (cb) => ipcRenderer.on('sync:need-password', (event, p) => cb(p)),
});

contextBridge.exposeInMainWorld('updateAPI', {
  get: () => ipcRenderer.invoke('update:get'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  setAuto: (autoCheck) => ipcRenderer.invoke('update:set-auto', { autoCheck }),
  onState: (cb) => ipcRenderer.on('update:state', (event, s) => cb(s)),
});

contextBridge.exposeInMainWorld('keysAPI', {
  parse: (text, passphrase) => ipcRenderer.invoke('keys:parse', { text, passphrase }),
  generate: (type, passphrase, comment) => ipcRenderer.invoke('keys:generate', { type, passphrase, comment }),
  openFile: () => ipcRenderer.invoke('keys:open-file'),
  savePublic: (name, publicKey) => ipcRenderer.invoke('keys:save-public', { name, publicKey }),
  install: (connId, publicKey) => ipcRenderer.invoke('keys:install', { connId, publicKey }),
});

contextBridge.exposeInMainWorld('githubAPI', {
  user: (token) => ipcRenderer.invoke('github:user', { token }),
  repos: (token) => ipcRenderer.invoke('github:repos', { token }),
  issues: (token, repo, state) => ipcRenderer.invoke('github:issues', { token, repo, state }),
  pulls: (token, repo, state) => ipcRenderer.invoke('github:pulls', { token, repo, state }),
  runs: (token, repo) => ipcRenderer.invoke('github:runs', { token, repo }),
  createIssue: (token, repo, title, body) => ipcRenderer.invoke('github:create-issue', { token, repo, title, body }),
  open: (url) => ipcRenderer.invoke('github:open', { url }),
  git: (params) => ipcRenderer.invoke('git:op', params),
  pickDir: (current) => ipcRenderer.invoke('git:pick-dir', { current }),
  home: () => ipcRenderer.invoke('git:home'),
  reveal: (dir) => ipcRenderer.invoke('git:reveal', { dir }),
});
