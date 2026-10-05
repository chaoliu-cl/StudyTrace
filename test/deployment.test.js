import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const [name, cwd, entry] of [
  ['repository root (Azure and Railway)', new URL('../', import.meta.url), 'index.js'],
  ['server directory (Railway)', new URL('../server/', import.meta.url), 'src/index.js'],
]) {
  test(`${name} starts and serves dashboards on PORT`, { timeout: 15000 }, async () => {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));

    // Never connect a deployment test to an inherited production database.
    const env = { ...process.env, PORT: String(port), NODE_ENV: 'production' };
    delete env.DATABASE_URL;
    delete env.ADMIN_TOKEN;
    const child = spawn(process.execPath, [entry], {
      cwd: fileURLToPath(cwd),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const base = `http://127.0.0.1:${port}`;

    try {
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        assert.equal(child.exitCode, null, output);
        try {
          const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
          assert.deepEqual(await res.json(), { ok: true });
          ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(ready, `Server did not become ready: ${output}`);
      const status = await fetch(`${base}/status`);
      assert.equal((await status.json()).database, 'missing');
      for (const path of ['/participant/', '/researcher/', '/admin/']) {
        const res = await fetch(base + path);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type'), /text\/html/, path);
        assert.match(await res.text(), /StudyTrace/, path);
      }
      const asset = await fetch(`${base}/assets/dashboard.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type'), /javascript/);
      const api = await fetch(`${base}/api/v1/studies/deployment-test/sensors/locations/count`);
      assert.equal(api.status, 503);
      assert.equal((await api.json()).error, 'database_not_configured');
    } finally {
      child.kill();
      await exited;
    }
  });
}
