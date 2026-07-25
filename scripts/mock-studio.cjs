// Mock Ulanzi Studio: WS server the plugin connects to, plus an HTTP control
// port to inject key events (run/keydown/keyup) during tests.
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'com.ulanzi.claudesessions.ulanziPlugin', 'node_modules', 'ws'));
const http = require('http');

const WS_PORT = 3999;
const CTRL_PORT = 3998;
const ACTION_UUID = 'com.ulanzi.ulanzistudio.claudesessions.sessionslot';

const KEYS = [
  { key: '0_0', actionid: 'aid-1' },
  { key: '1_0', actionid: 'aid-2' },
  { key: '2_0', actionid: 'aid-3' },
];

let plugin = null;

function tileState(dataUrl) {
  try {
    const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
    if (svg.includes('#FFC53D')) return 'WAITING';
    if (svg.includes('#2E9E4F')) return 'DONE';
    if (svg.includes('url(#g)')) return svg.includes('r="11"') ? 'THINKING' : 'THINKING?';
    if (svg.includes('#1C1C1E')) return 'IDLE';
    if (svg.includes('#141416')) return 'EMPTY';
    return 'UNKNOWN';
  } catch {
    return 'DECODE_ERR';
  }
}

function nameIn(dataUrl) {
  const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
  const m = svg.match(/font-weight="700"[^>]*>([^<]*)</);
  return m ? m[1] : '';
}

const wss = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`[mock] ws listening :${WS_PORT}`)
);

wss.on('connection', (ws) => {
  plugin = ws;
  console.log('[mock] plugin socket open');
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.cmd === 'connected') {
      console.log(`[mock] plugin registered: ${msg.uuid}`);
      // place the action on three keys
      for (const k of KEYS) {
        ws.send(JSON.stringify({ cmd: 'add', uuid: ACTION_UUID, key: k.key, actionid: k.actionid, param: {} }));
      }
      return;
    }
    if (msg.cmd === 'state' && msg.param && msg.param.statelist) {
      for (const s of msg.param.statelist) {
        console.log(`[mock] PUSH key=${s.key} type=${s.type} state=${tileState(s.data)} name="${nameIn(s.data)}"`);
      }
      return;
    }
    if (msg.code !== undefined) return; // plugin's ack echo — ignore
    console.log('[mock] recv', JSON.stringify(msg).slice(0, 200));
  });
  ws.on('close', () => console.log('[mock] plugin socket closed'));
});

// control endpoint: POST /send with {cmd,keyIndex} -> forwards event to plugin
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { cmd, keyIndex } = JSON.parse(body || '{}');
        const k = KEYS[keyIndex || 0];
        if (plugin && plugin.readyState === WebSocket.OPEN) {
          plugin.send(JSON.stringify({ cmd, uuid: ACTION_UUID, key: k.key, actionid: k.actionid, param: {} }));
          console.log(`[mock] injected ${cmd} on key ${k.key}`);
        }
        res.writeHead(200).end('ok');
      } catch (e) {
        res.writeHead(400).end(String(e));
      }
    });
  })
  .listen(CTRL_PORT, '127.0.0.1', () => console.log(`[mock] ctrl listening :${CTRL_PORT}`));
