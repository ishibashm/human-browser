import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { WebSocket } from 'ws';
import { startDaemon } from '../../src/daemon/app.ts';
import type { DaemonConfig } from '../../src/shared/types.ts';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate free port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function callDaemonRaw(config: DaemonConfig, command: string, args: Record<string, unknown>) {
  const response = await fetch(`http://${config.daemon.host}:${config.daemon.port}/v1/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hb-token': config.auth.token,
    },
    body: JSON.stringify({
      command,
      args,
      queue_mode: 'hold',
      timeout_ms: 3000,
    }),
  });

  const payload = (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };

  return payload;
}

async function callDaemon(config: DaemonConfig, command: string, args: Record<string, unknown>) {
  const payload = await callDaemonRaw(config, command, args);
  if (!payload.ok) {
    throw new Error(`${payload.error?.code}: ${payload.error?.message}`);
  }
  return payload.data ?? {};
}

test('snapshot -> click -> fill roundtrip works via daemon/bridge protocol', async () => {
  const port = await getFreePort();
  const config: DaemonConfig = {
    daemon: {
      host: '127.0.0.1',
      port,
    },
    auth: {
      token: 'testtoken_testtoken_testtoken',
    },
    diagnostics: {
      max_events: 100,
    },
  };

  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'fixed.html');
  const html = await readFile(fixturePath, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });

  const button = dom.window.document.querySelector('#login');
  if (!(button instanceof dom.window.HTMLButtonElement)) {
    throw new Error('button fixture missing');
  }
  button.addEventListener('click', () => {
    button.setAttribute('data-clicked', '1');
  });

  const duplicateButton1 = dom.window.document.createElement('button');
  duplicateButton1.id = 'dup-login-1';
  duplicateButton1.className = 'dup-login';
  duplicateButton1.textContent = 'duplicate 1';
  duplicateButton1.addEventListener('click', () => {
    duplicateButton1.setAttribute('data-clicked', '1');
  });
  dom.window.document.body.appendChild(duplicateButton1);

  const duplicateButton2 = dom.window.document.createElement('button');
  duplicateButton2.id = 'dup-login-2';
  duplicateButton2.className = 'dup-login';
  duplicateButton2.textContent = 'duplicate 2';
  duplicateButton2.addEventListener('click', () => {
    duplicateButton2.setAttribute('data-clicked', '1');
  });
  dom.window.document.body.appendChild(duplicateButton2);

  const duplicateInput1 = dom.window.document.createElement('input');
  duplicateInput1.id = 'dup-email-1';
  duplicateInput1.className = 'dup-email';
  duplicateInput1.placeholder = '重複メール';
  dom.window.document.body.appendChild(duplicateInput1);

  const duplicateInput2 = dom.window.document.createElement('input');
  duplicateInput2.id = 'dup-email-2';
  duplicateInput2.className = 'dup-email';
  duplicateInput2.placeholder = '重複メール';
  dom.window.document.body.appendChild(duplicateInput2);

  const daemon = await startDaemon(config);
  let lastSnapshotPayload: Record<string, unknown> | undefined;
  let snapshotCount = 0;
  let baselineDir: string | undefined;

  const ws = new WebSocket(`ws://${config.daemon.host}:${config.daemon.port}/bridge?token=${config.auth.token}`);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'HELLO', version: 'test', retry_count: 0 }));

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as {
      type: string;
      request_id?: string;
      command?: string;
      payload?: Record<string, unknown>;
      ts?: string;
    };

    if (message.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG', ts: message.ts }));
      return;
    }

    if (message.type !== 'COMMAND' || !message.request_id || !message.command) {
      return;
    }

    const reply = (ok, resultOrError) => {
      if (ok) {
        ws.send(
          JSON.stringify({
            type: 'RESULT',
            request_id: message.request_id,
            ok: true,
            result: resultOrError,
          }),
        );
        return;
      }

      ws.send(
        JSON.stringify({
          type: 'RESULT',
          request_id: message.request_id,
          ok: false,
          error: resultOrError,
        }),
      );
    };

    if (message.command === 'list_tabs') {
      reply(true, {
        tabs: [{ id: 1, active: true, title: 'fixture', url: dom.window.location.href }],
      });
      return;
    }

    if (message.command === 'select_tab') {
      reply(true, { tab_id: 1 });
      return;
    }

    if (message.command === 'snapshot') {
      snapshotCount += 1;
      lastSnapshotPayload = message.payload;
      const nodes = [
        { role: 'button', name: 'ログイン', selector: '#login' },
        { role: 'textbox', name: 'メールアドレス', selector: '#email' },
        { role: 'button', name: '重複ボタン', selector: '#dup-login-1' },
        { role: 'button', name: '重複ボタン', selector: '#dup-login-2' },
        { role: 'textbox', name: '重複メール', selector: '#dup-email-1' },
        { role: 'textbox', name: '重複メール', selector: '#dup-email-2' },
      ];
      if (snapshotCount >= 2) {
        nodes.push({ role: 'link', name: 'ヘルプ', selector: '#help-link' });
      }
      reply(true, {
        tab_id: 1,
        nodes,
      });
      return;
    }

    if (message.command === 'click') {
      const selector = String(message.payload?.selector ?? '');
      const nthRaw = message.payload?.nth;
      const nth = typeof nthRaw === 'number' && Number.isInteger(nthRaw) ? nthRaw : 0;
      const all = dom.window.document.querySelectorAll(selector);
      const index = nth === -1 ? all.length - 1 : nth;
      const el = all[index];
      if (!el) {
        reply(false, { code: 'NO_MATCH', message: 'selector not found' });
        return;
      }
      if (el instanceof dom.window.HTMLElement) {
        el.click();
      }
      reply(true, { ok: true });
      return;
    }

    if (message.command === 'fill') {
      const selector = String(message.payload?.selector ?? '');
      const value = String(message.payload?.value ?? '');
      const nthRaw = message.payload?.nth;
      const nth = typeof nthRaw === 'number' && Number.isInteger(nthRaw) ? nthRaw : 0;
      const all = dom.window.document.querySelectorAll(selector);
      const index = nth === -1 ? all.length - 1 : nth;
      const input = all[index];
      if (!(input instanceof dom.window.HTMLInputElement)) {
        reply(false, { code: 'NOT_FILLABLE', message: 'input not found' });
        return;
      }
      input.value = value;
      reply(true, { ok: true });
      return;
    }

    if (message.command === 'value') {
      const selector = String(message.payload?.selector ?? '');
      const nthRaw = message.payload?.nth;
      const nth = typeof nthRaw === 'number' && Number.isInteger(nthRaw) ? nthRaw : 0;
      const all = dom.window.document.querySelectorAll(selector);
      const index = nth === -1 ? all.length - 1 : nth;
      const input = all[index];
      if (!(input instanceof dom.window.HTMLInputElement)) {
        reply(false, { code: 'NOT_READABLE', message: 'value not readable' });
        return;
      }
      reply(true, { ok: true, value: input.value });
      return;
    }

    if (message.command === 'reset' || message.command === 'reconnect') {
      reply(true, { ok: true });
      return;
    }

    reply(false, { code: 'UNKNOWN', message: `Unhandled command: ${message.command}` });
  });

  try {
    const firstSnapshot = await callDaemon(config, 'snapshot', {
      interactive: true,
      cursor: true,
      compact: true,
      depth: 2,
      selector: '#app',
    });
    assert.deepEqual(lastSnapshotPayload, {
      target: 'active',
      interactive: true,
      cursor: true,
      compact: true,
      depth: 2,
      selector: '#app',
    });

    const snapshot = await callDaemon(config, 'snapshot', {});
    const snapshotId = String(snapshot.snapshot_id);

    assert.match(snapshot.tree ? String(snapshot.tree) : '', /\[ref=e1\]/);
    assert.match(snapshot.tree ? String(snapshot.tree) : '', /\[ref=e2\]/);
    assert.match(snapshot.tree ? String(snapshot.tree) : '', /\[ref=e3\]/);

    baselineDir = await mkdtemp(join(tmpdir(), 'human-browser-diff-'));
    const baselinePath = join(baselineDir, 'baseline.txt');
    await writeFile(baselinePath, String(firstSnapshot.tree), 'utf8');
    const diff = await callDaemon(config, 'diff_snapshot', {
      baseline: baselinePath,
    });
    assert.equal(diff.changed, true);
    assert.equal((diff.additions as number) > 0, true);

    await callDaemon(config, 'click', {
      ref: 'e1',
      snapshot_id: snapshotId,
    });

    await callDaemon(config, 'fill', {
      ref: 'e2',
      value: 'alice@example.com',
      snapshot_id: snapshotId,
    });
    const refValue = await callDaemon(config, 'value', {
      ref: 'e2',
      snapshot_id: snapshotId,
    });
    assert.equal(String(refValue.result?.value), 'alice@example.com');

    await callDaemon(config, 'click', {
      ref: 'e4',
      snapshot_id: snapshotId,
    });

    await callDaemon(config, 'fill', {
      ref: 'e6',
      value: 'ref-second@example.com',
      snapshot_id: snapshotId,
    });
    assert.equal(duplicateInput2.value, 'ref-second@example.com');

    const refWithoutSnapshot = await callDaemonRaw(config, 'click', {
      ref: 'e1',
    });
    assert.equal(refWithoutSnapshot.ok, false);
    assert.equal(refWithoutSnapshot.error?.code, 'BAD_REQUEST');
    assert.match(refWithoutSnapshot.error?.message ?? '', /requires args\.snapshot_id/);

    await callDaemon(config, 'click', {
      selector: '#login',
    });

    await callDaemon(config, 'fill', {
      selector: '#email',
      value: 'bob@example.com',
    });
    const selectorValue = await callDaemon(config, 'value', {
      selector: '#email',
    });
    assert.equal(String(selectorValue.result?.value), 'bob@example.com');

    await callDaemon(config, 'click', {
      selector: '.dup-login',
      nth: 1,
    });

    await callDaemon(config, 'fill', {
      selector: '.dup-email',
      value: 'nth@example.com',
      nth: -1,
    });

    const clicked = dom.window.document.querySelector('#login')?.getAttribute('data-clicked');
    assert.equal(clicked, '1');

    const email = dom.window.document.querySelector('#email');
    if (!(email instanceof dom.window.HTMLInputElement)) {
      throw new Error('email input missing');
    }
    assert.equal(email.value, 'bob@example.com');

    assert.equal(duplicateButton1.getAttribute('data-clicked'), null);
    assert.equal(duplicateButton2.getAttribute('data-clicked'), '1');
    assert.equal(duplicateInput1.value, '');
    assert.equal(duplicateInput2.value, 'nth@example.com');
  } finally {
    ws.close();
    await daemon.close();
    if (baselineDir) {
      await rm(baselineDir, { recursive: true, force: true });
    }
  }
});
