// Live view of the virtual Pi. Open http://127.0.0.1:8081 on the host.
// Shows what VLC is playing (read from its real web interface) and the server's
// command log as it happens. Read only, no dependencies.
'use strict';

const http = require('http');
const fs = require('fs');
const dgram = require('dgram');
const { execFile } = require('child_process');

const AUTH = 'Basic ' + Buffer.from(':backpack').toString('base64');

function vlcStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8080, path: '/requests/status.json', headers: { Authorization: AUTH }, timeout: 1500 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function unitActive(name) {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'is-active', name], (err, out) => resolve(String(out).trim() === 'active'));
  });
}

function raStatus() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { s.close(); } catch {} resolve(null); }, 400);
    s.on('message', (m) => { clearTimeout(t); try { s.close(); } catch {} resolve(m.toString().trim()); });
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.send('GET_STATUS', 55355, '127.0.0.1');
  });
}

function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Virtual Pi</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#12111a;color:#eceaf5;font:15px/1.5 system-ui,sans-serif}
  main{max-width:860px;margin:0 auto;padding:28px 20px}
  h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#9b95b8;margin:0 0 18px}
  .card{background:#1c1a27;border:1px solid #302d42;border-radius:16px;padding:22px;margin-bottom:18px}
  .state{display:inline-block;padding:3px 12px;border-radius:99px;font:600 12px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase}
  .playing{background:#173a2a;color:#5fd39a}.paused{background:#3d3218;color:#ffbf5a}.stopped{background:#2a2838;color:#9b95b8}
  .file{font-size:26px;font-weight:650;margin:12px 0 16px;word-break:break-word}
  .bar{height:8px;border-radius:5px;background:#2a2838;overflow:hidden}.fill{height:100%;background:#8c7bf6;transition:width .4s linear}
  .times{display:flex;justify-content:space-between;color:#9b95b8;font:13px ui-monospace,monospace;margin-top:8px}
  pre{margin:0;max-height:320px;overflow:auto;font:13px/1.55 ui-monospace,monospace;color:#c9c5de;white-space:pre-wrap}
  .cmd{color:#ffbf5a}.err{color:#ff7a7a}
</style>
<main>
  <h1>Virtual Pi &middot; live</h1>
  <div class="card">
    <span id="mode" class="state stopped">mode</span>
    <div id="modetext" class="file" style="font-size:20px;margin:10px 0 0;color:#c9c5de"></div>
  </div>
  <div class="card">
    <span id="state" class="state stopped">stopped</span>
    <div id="file" class="file">Nothing playing</div>
    <div class="bar"><div id="fill" class="fill" style="width:0"></div></div>
    <div class="times"><span id="pos">0:00</span><span id="vol"></span><span id="dur">0:00</span></div>
  </div>
  <div class="card"><h1>Server log</h1><pre id="log"></pre></div>
</main>
<script>
const fmt=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
async function tick(){
  try{
    const d=await (await fetch('/api')).json();
    const mEl=document.getElementById('mode');
    if(d.game){mEl.textContent='game mode';mEl.className='state playing';
      const r=d.ra||'';document.getElementById('modetext').textContent=
        r.indexOf('CONTENTLESS')>-1?'RetroArch is running, showing the game menu. Video player is stopped.'
        :r.indexOf('PLAYING')>-1?'RetroArch is playing: '+(r.split(',')[1]||'a game')+'. Video player is stopped.'
        :r.indexOf('PAUSED')>-1?'RetroArch is paused: '+(r.split(',')[1]||'a game')+'. Video player is stopped.'
        :'RetroArch is starting.';}
    else if(d.video){mEl.textContent='video mode';mEl.className='state paused';
      document.getElementById('modetext').textContent='VLC is running. RetroArch is stopped.';}
    else{mEl.textContent='none';mEl.className='state stopped';document.getElementById('modetext').textContent='Nothing is running.';}
    const v=d.vlc;
    const st=v&&v.state?v.state:'stopped';
    const el=document.getElementById('state');el.textContent=st;el.className='state '+st;
    const f=v&&v.information&&v.information.category&&v.information.category.meta&&v.information.category.meta.filename;
    document.getElementById('file').textContent=(st!=='stopped'&&f)?f:'Nothing playing';
    const len=v&&v.length||0,t=v&&v.time||0;
    document.getElementById('fill').style.width=(len?Math.min(100,t/len*100):0)+'%';
    document.getElementById('pos').textContent=fmt(t);document.getElementById('dur').textContent=fmt(len);
    document.getElementById('vol').textContent=v?'volume '+Math.round((v.volume||0)/2.56)+'%':'VLC not reachable';
    const log=document.getElementById('log');
    log.innerHTML=d.log.map(l=>'<div class="'+(/\\[cmd\\] /.test(l)?'cmd':/rror|fail|timed out/i.test(l)?'err':'')+'">'+l.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>').join('');
    log.scrollTop=log.scrollHeight;
  }catch(e){}
}
setInterval(tick,500);tick();
</script>`;

http.createServer(async (req, res) => {
  if (req.url === '/api') {
    const [video, game] = await Promise.all([unitActive('video-mode'), unitActive('game-mode')]);
    const ra = game ? await raStatus() : null;
    const body = JSON.stringify({ vlc: await vlcStatus(), video, game, ra, log: tail('/tmp/server.log', 40) });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(8081, '0.0.0.0', () => console.log('[sim] dashboard on :8081'));
