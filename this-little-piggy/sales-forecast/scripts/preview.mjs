#!/usr/bin/env node
/**
 * Local preview of the web app with NO Google or HubSpot access: runs the real .gs code in the test
 * harness (fake HubSpot serving the 2026-09-25 live pulls, in-memory Sheets) and serves Index.html with a
 * google.script.run shim that calls the server functions over HTTP.
 *
 *   node scripts/preview.mjs [port]        then open http://localhost:<port>/?as=ben.dewinter@findigs.com
 * `as` sets the signed-in Google identity (defaults to the first roster AE).
 *   node scripts/preview.mjs 8787 --synthetic   test mode + four weeks of synthetic history (Section 3)
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadApp } from '../tests/helpers/gas_harness.mjs';

const SHIM = (as) => `<script>
(function(){
  var AS = ${JSON.stringify(as)};
  function runner(){
    var ok = null, fail = null, r = {}, p;
    r.withSuccessHandler = function(f){ ok = f; return p; };
    r.withFailureHandler = function(f){ fail = f; return p; };
    return p = new Proxy(r, { get: function(t, k){ if (k in t) return t[k]; return function(){
      var args = Array.prototype.slice.call(arguments), S = ok, F = fail;
      fetch('/rpc/' + k + '?as=' + encodeURIComponent(AS), { method: 'POST', body: JSON.stringify(args) })
        .then(function(res){ return res.json(); })
        .then(function(j){ if (j.error) { F && F(new Error(j.error)); } else { S && S(j.result); } })
        .catch(function(e){ F && F(e); });
    }; } });
  }
  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: runner });
})();
</script>`;

export function startPreview({ port = 0, delayMs = 0, defaultAs = 'ben.dewinter@findigs.com', appOpts = {}, synthetic = false } = {}) {
  const app = loadApp({ email: defaultAs, ...(synthetic ? { testFolderId: 'TEST-FOLDER' } : {}), ...appOpts });
  // The clock starts at appOpts.now (if given) and then ticks in real time, like production.
  const base = app.store.clock, started = Date.now();
  app.ctx.nowMs_ = () => base + (Date.now() - started);
  app.ctx.pullData_();
  if (synthetic) app.ctx.seedSyntheticSnapshots();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const as = u.searchParams.get('as') || defaultAs;
    app.session.email = as;
    if (req.method === 'GET' && u.pathname === '/') {
      const html = app.ctx.doGet().getContent().replace('</head>', SHIM(as) + '</head>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'POST' && u.pathname.startsWith('/rpc/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => setTimeout(() => {
        app.session.email = as;
        let out;
        try { out = { result: app.call(u.pathname.slice(5), ...JSON.parse(body || '[]')) }; }
        catch (e) { out = { error: e.message }; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      }, delayMs));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, app, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startPreview({ port: Number(process.argv[2] || 8787), synthetic: process.argv.includes('--synthetic') });
  console.log(`preview at ${url}/?as=ben.dewinter@findigs.com  (try ?as=brian.korchin@findigs.com)`);
}
