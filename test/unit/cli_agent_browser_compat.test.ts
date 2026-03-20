import test from 'node:test';
import assert from 'node:assert/strict';
import { toDaemonRequest } from '../../src/cli/human-browser.ts';
import { HBError } from '../../src/shared/errors.ts';

test('open maps to daemon open command', () => {
  const request = toDaemonRequest('open', ['https://example.com']);
  assert.equal(request.command, 'open');
  assert.deepEqual(request.args, {
    url: 'https://example.com',
    tab_id: undefined,
  });
});

test('new-tab maps to daemon new_tab command', () => {
  const request = toDaemonRequest('new-tab', ['https://example.com', '--tab', 'active']);
  assert.equal(request.command, 'new_tab');
  assert.deepEqual(request.args, {
    url: 'https://example.com',
    anchor_tab_id: 'active',
  });
});

test('screenshot supports optional path and --full', () => {
  const request = toDaemonRequest('screenshot', ['output.png', '--full', '--tab', 'active']);
  assert.equal(request.command, 'screenshot');
  assert.deepEqual(request.args, {
    path: 'output.png',
    selector: undefined,
    full_page: true,
    tab_id: 'active',
  });
});

test('screenshot supports selector and optional output path', () => {
  const request = toDaemonRequest('screenshot', ['#hero', 'capture.png', '--full']);
  assert.equal(request.command, 'screenshot');
  assert.deepEqual(request.args, {
    selector: '#hero',
    path: 'capture.png',
    full_page: true,
    tab_id: undefined,
  });
});

test('get text with ref requires snapshot id', () => {
  assert.throws(
    () => {
      toDaemonRequest('get', ['text', '@e1']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('get value with ref requires snapshot id', () => {
  assert.throws(
    () => {
      toDaemonRequest('get', ['value', '@e1']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('get value maps to value command', () => {
  const request = toDaemonRequest('get', ['value', '#email']);
  assert.equal(request.command, 'value');
  assert.deepEqual(request.args, {
    selector: '#email',
  });
});

test('cookies set maps to cookies_set', () => {
  const request = toDaemonRequest('cookies', ['set', 'session', 'abc', '--url', 'https://example.com']);
  assert.equal(request.command, 'cookies_set');
  assert.deepEqual(request.args, {
    name: 'session',
    value: 'abc',
    url: 'https://example.com',
  });
});

test('network requests maps to network_dump', () => {
  const request = toDaemonRequest('network', ['requests', '--filter', 'api', '--clear']);
  assert.equal(request.command, 'network_dump');
  assert.deepEqual(request.args, {
    filter: 'api',
    clear: true,
    tab_id: undefined,
  });
});

test('console default maps to console_dump', () => {
  const request = toDaemonRequest('console', []);
  assert.equal(request.command, 'console_dump');
  assert.deepEqual(request.args, {
    clear: false,
    tab_id: undefined,
  });
});

test('record start maps to record_start', () => {
  const request = toDaemonRequest('record', ['start', 'demo.webm', '--tab', 'active', '--fps', '8']);
  assert.equal(request.command, 'record_start');
  assert.deepEqual(request.args, {
    path: 'demo.webm',
    tab_id: 'active',
    fps: 8,
  });
});

test('record stop maps to record_stop', () => {
  const request = toDaemonRequest('record', ['stop']);
  assert.equal(request.command, 'record_stop');
  assert.deepEqual(request.args, {});
});

test('record restart maps to record_restart', () => {
  const request = toDaemonRequest('record', ['restart', 'take2.webm']);
  assert.equal(request.command, 'record_restart');
  assert.deepEqual(request.args, {
    path: 'take2.webm',
    tab_id: undefined,
    fps: undefined,
  });
});

test('record fps validation rejects out-of-range value', () => {
  assert.throws(
    () => {
      toDaemonRequest('record', ['start', 'demo.webm', '--fps', '31']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('wait-for alias maps to wait', () => {
  const request = toDaemonRequest('wait-for', ['#ready', '--timeout', '1500']);
  assert.equal(request.command, 'wait');
  assert.deepEqual(request.args, {
    selector: '#ready',
    timeout_ms: 1500,
  });
});

test('click supports --nth for selector targeting', () => {
  const request = toDaemonRequest('click', ['.scene-card button', '--nth', '1']);
  assert.equal(request.command, 'click');
  assert.deepEqual(request.args, {
    selector: '.scene-card button',
    nth: 1,
  });
});

test('fill supports --nth and ref payloads', () => {
  const request = toDaemonRequest('fill', ['@e2', 'value', '--snapshot', 's1', '--nth', '-1']);
  assert.equal(request.command, 'fill');
  assert.deepEqual(request.args, {
    ref: 'e2',
    value: 'value',
    snapshot_id: 's1',
    nth: -1,
  });
});

test('dialog accept maps prompt text and tab to daemon args', () => {
  const request = toDaemonRequest('dialog', ['accept', 'confirmed', '--tab', 'active']);
  assert.equal(request.command, 'dialog');
  assert.deepEqual(request.args, {
    response: 'accept',
    prompt_text: 'confirmed',
    tab_id: 'active',
  });
});

test('dialog dismiss rejects prompt text', () => {
  assert.throws(
    () => {
      toDaemonRequest('dialog', ['dismiss', 'nope']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('--nth must be integer >= -1', () => {
  assert.throws(
    () => {
      toDaemonRequest('click', ['#login', '--nth', '-2']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});
