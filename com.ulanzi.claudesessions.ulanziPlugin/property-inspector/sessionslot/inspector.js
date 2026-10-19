// Config UI for all Session Slot keys. The main service is the source of
// truth: on connect we ask it for the current config, and edits are sent
// back as sendToPlugin pass-through messages (persisted server-side in
// config.json — see plugin/config.js for why the Studio settings API is
// not used).

/* global $UD */

const FIELDS = ['httpPort', 'staleTimeoutMin', 'focusApp', 'nameSource', 'slotOrder', 'animateThinking'];
let applying = false;
// Current servers object (origin -> {sshTarget, claudePath?}); mutated by the
// add/remove UI and sent back whole. claudePath (not shown) is preserved by
// round-tripping the loaded entry untouched.
let servers = {};

function readForm() {
  return {
    httpPort: parseInt(document.getElementById('httpPort').value, 10),
    staleTimeoutMin: parseInt(document.getElementById('staleTimeoutMin').value, 10),
    focusApp: document.getElementById('focusApp').value,
    nameSource: document.getElementById('nameSource').value,
    slotOrder: document.getElementById('slotOrder').value,
    animateThinking: document.getElementById('animateThinking').checked,
    servers,
  };
}

function sendConfig() {
  $UD.sendToPlugin({ type: 'configUpdate', config: readForm() });
}

function renderServers() {
  const list = document.getElementById('serverList');
  list.textContent = '';
  const origins = Object.keys(servers);
  if (!origins.length) {
    const empty = document.createElement('div');
    empty.className = 'server-empty';
    empty.textContent = 'None — add one below.';
    list.appendChild(empty);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'server-row';
    const label = document.createElement('span');
    const code = document.createElement('code');
    code.textContent = origin;
    label.appendChild(code);
    label.append(` ${servers[origin].sshTarget || ''}`);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      delete servers[origin];
      renderServers();
      sendConfig();
    });
    row.appendChild(label);
    row.appendChild(rm);
    list.appendChild(row);
  }
}

function fillForm(config, focusApps) {
  applying = true;
  const select = document.getElementById('focusApp');
  if (focusApps && select.options.length === 0) {
    for (const app of focusApps) {
      const opt = document.createElement('option');
      opt.value = app;
      opt.textContent = app;
      select.appendChild(opt);
    }
  }
  document.getElementById('httpPort').value = config.httpPort;
  document.getElementById('staleTimeoutMin').value = config.staleTimeoutMin;
  select.value = config.focusApp;
  document.getElementById('nameSource').value = config.nameSource || 'title';
  document.getElementById('slotOrder').value = config.slotOrder || 'fixed';
  document.getElementById('animateThinking').checked = !!config.animateThinking;
  servers = config.servers ? JSON.parse(JSON.stringify(config.servers)) : {};
  renderServers();
  applying = false;
}

// Shared by the Claude Code and Codex rows. Codex is optional, so a missing
// ~/.codex/hooks.json just reads "not installed" rather than an error.
function renderHooks(status, pluginPort, elId = 'hooksStatus', missingText = 'Claude Code not found') {
  const el = document.getElementById(elId);
  if (!status || !status.settingsExists) {
    el.className = 'hooks-status bad';
    el.textContent = missingText;
    return;
  }
  const n = status.events.length;
  if (n === 0) {
    el.className = 'hooks-status bad';
    el.textContent = 'not installed';
    return;
  }
  const portMismatch = status.port && pluginPort && String(status.port) !== String(pluginPort);
  el.className = portMismatch || n < status.expected ? 'hooks-status bad' : 'hooks-status ok';
  let txt = `${n}/${status.expected} events · port ${status.port}`;
  if (portMismatch) txt += ` ⚠ plugin is on ${pluginPort}`;
  else if (n < status.expected) txt += ' ⚠ update needed';
  el.textContent = txt;
}

$UD.connect();

$UD.onConnected(() => {
  document.querySelector('.udpi-wrapper').classList.remove('hidden');
  $UD.sendToPlugin({ type: 'configRequest' });
  $UD.sendToPlugin({ type: 'hooksStatus' });
});

$UD.onSendToPropertyInspector((jsn) => {
  const payload = jsn.payload || jsn.param || {};
  if (payload.type === 'config' && payload.config) {
    fillForm(payload.config, payload.focusApps);
  } else if (payload.type === 'hooks') {
    renderHooks(payload.status, payload.pluginPort);
  } else if (payload.type === 'codexHooks') {
    renderHooks(payload.status, payload.pluginPort, 'codexHooksStatus', 'not installed');
  }
});

document.getElementById('hooksInstall').addEventListener('click', () => {
  document.getElementById('hooksStatus').textContent = 'installing…';
  $UD.sendToPlugin({ type: 'hooksInstall' });
});
document.getElementById('hooksRemove').addEventListener('click', () => {
  $UD.sendToPlugin({ type: 'hooksUninstall' });
});
document.getElementById('codexHooksInstall').addEventListener('click', () => {
  document.getElementById('codexHooksStatus').textContent = 'installing…';
  $UD.sendToPlugin({ type: 'codexHooksInstall' });
});
document.getElementById('codexHooksRemove').addEventListener('click', () => {
  $UD.sendToPlugin({ type: 'codexHooksUninstall' });
});

for (const id of FIELDS) {
  document.getElementById(id).addEventListener('change', () => {
    if (applying) return;
    sendConfig();
  });
}

document.getElementById('srvAdd').addEventListener('click', () => {
  const err = document.getElementById('srvErr');
  const oEl = document.getElementById('srvOrigin');
  const tEl = document.getElementById('srvTarget');
  const origin = oEl.value.trim();
  const target = tEl.value.trim();
  err.textContent = '';
  if (!/^[\w-]{1,32}$/.test(origin) || origin === 'local') {
    err.textContent = 'Label: 1–32 chars (letters, digits, -, _), not "local"';
    return;
  }
  if (!/^[\w.@-]{1,128}$/.test(target)) {
    err.textContent = 'Target: user@host (letters, digits, . @ -)';
    return;
  }
  servers[origin] = { ...(servers[origin] || {}), sshTarget: target };
  oEl.value = '';
  tEl.value = '';
  renderServers();
  sendConfig();
});
