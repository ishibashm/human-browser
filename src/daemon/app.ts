import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { URL } from 'node:url';
import { HBError, asStructuredError } from '../shared/errors.ts';
import { buildSnapshot } from '../shared/snapshot.ts';
import { diffSnapshotText } from '../shared/snapshot-diff.ts';
import { diffImages } from '../shared/image-diff.ts';
import type {
  DaemonApiResponse,
  DaemonConfig,
  DaemonEvent,
  DiagnosticsReport,
  DialogState,
  ExtensionToDaemonEnvelope,
  QueueMode,
  SnapshotData,
  SnapshotNode,
  SnapshotOptions,
  StructuredError,
} from '../shared/types.ts';

interface PendingCommand {
  requestId: string;
  command: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: StructuredError) => void;
  timer: NodeJS.Timeout;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (reason: StructuredError) => void;
  timer: NodeJS.Timeout;
}

interface RuntimeState {
  config: DaemonConfig;
  extensionSocket?: WebSocket;
  extensionConnectedAt?: string;
  lastPingAt?: string;
  lastDisconnectReason?: string;
  reconnectAttempts: number;
  selectedTabId?: number;
  latestSnapshot?: SnapshotData;
  dialog?: DialogState;
  snapshotById: Map<string, SnapshotData>;
  snapshotOrder: string[];
  pendingCommands: Map<string, PendingCommand>;
  connectionWaiters: ConnectionWaiter[];
  events: DaemonEvent[];
  disconnectHistory: Array<{ at: string; reason: string }>;
  reconnectHistory: Array<{ at: string; reason: string }>;
  recording?: RecordingSession;
}

interface RecordingSession {
  tabId: number;
  outputPath: string;
  frameDir: string;
  fps: number;
  frameCount: number;
  startedAt: string;
  lastFrameAt?: string;
  lastCaptureError?: StructuredError;
  captureInFlight?: Promise<void>;
  timer?: NodeJS.Timeout;
  active: boolean;
  stopping: boolean;
  queueMode: QueueMode;
  timeoutMs: number;
}

export interface StartedDaemon {
  close: () => Promise<void>;
  port: number;
  host: string;
  getDiagnostics: (limit: number) => DiagnosticsReport;
}

const MAX_SNAPSHOT_HISTORY = 20;

export async function startDaemon(config: DaemonConfig): Promise<StartedDaemon> {
  const state: RuntimeState = {
    config,
    reconnectAttempts: 0,
    dialog: undefined,
    snapshotById: new Map(),
    snapshotOrder: [],
    pendingCommands: new Map(),
    connectionWaiters: [],
    events: [],
    disconnectHistory: [],
    reconnectHistory: [],
    recording: undefined,
  };

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(state, req, res);
  });

  const bridgeServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    void handleUpgrade(state, bridgeServer, request, socket, head);
  });

  bridgeServer.on('connection', (ws) => {
    onExtensionConnected(state, ws);
  });

  const heartbeat = setInterval(() => {
    if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
      return;
    }

    const payload = JSON.stringify({ type: 'PING', ts: new Date().toISOString() });
    state.extensionSocket.send(payload, (error) => {
      if (error) {
        logEvent(state, 'warn', 'bridge.ping_send_failed', 'Failed to send PING to extension', {
          error: error.message,
        });
      }
    });
  }, 5000);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.daemon.port, config.daemon.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  logEvent(state, 'info', 'daemon.started', 'Daemon started', {
    host: config.daemon.host,
    port: config.daemon.port,
  });

  return {
    close: async () => {
      clearInterval(heartbeat);
      if (state.recording?.timer) {
        clearInterval(state.recording.timer);
      }
      rejectAllPending(state, {
        code: 'DISCONNECTED',
        message: 'Daemon shutting down',
      });
      rejectConnectionWaiters(state, {
        code: 'DISCONNECTED',
        message: 'Daemon shutting down',
      });
      await closeServer(httpServer);
      bridgeServer.close();
    },
    port: config.daemon.port,
    host: config.daemon.host,
    getDiagnostics: (limit) => buildDiagnostics(state, limit),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function authorizeHttp(state: RuntimeState, req: IncomingMessage): void {
  const token = req.headers['x-hb-token'];
  if (typeof token !== 'string' || token !== state.config.auth.token) {
    throw new HBError('UNAUTHORIZED', 'Invalid token', undefined, {
      next_command: 'human-browser init',
    });
  }
}

async function handleHttpRequest(state: RuntimeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        data: {
          status: 'ok',
          now: new Date().toISOString(),
        },
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/command') {
      sendJson(res, 404, {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Not found',
        },
      });
      return;
    }

    authorizeHttp(state, req);
    const payload = await readJsonBody(req);
    const command = getStringField(payload, 'command');
    const args = getObjectField(payload, 'args', {});
    const timeoutMs = getNumberField(payload, 'timeout_ms', 10000);
    const queueMode = getQueueMode(payload, 'queue_mode', 'hold');
    const result = await executeCommand(state, command, args, { timeoutMs, queueMode });

    sendJson(res, 200, {
      ok: true,
      data: result,
    });
  } catch (error) {
    const structured = asStructuredError(error);
    const status = structured.code === 'UNAUTHORIZED' ? 401 : 400;
    sendJson(res, status, {
      ok: false,
      error: structured,
    });
  }
}

async function handleUpgrade(
  state: RuntimeState,
  bridgeServer: WebSocketServer,
  request: IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer,
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? state.config.daemon.host}`);
    if (requestUrl.pathname !== '/bridge') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = requestUrl.searchParams.get('token');
    if (token !== state.config.auth.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      logEvent(state, 'warn', 'bridge.auth_failed', 'Bridge auth failed', {
        remote: request.socket.remoteAddress,
      });
      return;
    }

    bridgeServer.handleUpgrade(request, socket, head, (ws) => {
      bridgeServer.emit('connection', ws, request);
    });
  } catch (error) {
    socket.destroy();
    logEvent(state, 'error', 'bridge.upgrade_failed', 'Bridge upgrade failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function onExtensionConnected(state: RuntimeState, ws: WebSocket): void {
  if (state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN) {
    state.extensionSocket.close(1000, 'Replaced by a new extension connection');
  }

  state.extensionSocket = ws;
  state.extensionConnectedAt = new Date().toISOString();
  state.reconnectAttempts = 0;
  state.dialog = undefined;
  state.reconnectHistory.push({
    at: state.extensionConnectedAt,
    reason: 'extension_connected',
  });
  truncateHistory(state);

  resolveConnectionWaiters(state);
  logEvent(state, 'info', 'bridge.connected', 'Extension bridge connected');

  ws.on('message', (data) => {
    void handleExtensionMessage(state, data.toString());
  });

  ws.on('close', (code, reasonBuffer) => {
    if (state.extensionSocket !== ws) {
      return;
    }

    const reason = reasonBuffer.toString() || `close_code_${code}`;
    state.extensionSocket = undefined;
    state.dialog = undefined;
    state.lastDisconnectReason = reason;
    state.reconnectAttempts += 1;
    state.disconnectHistory.push({
      at: new Date().toISOString(),
      reason,
    });
    truncateHistory(state);
    logEvent(state, 'warn', 'bridge.disconnected', 'Extension bridge disconnected', {
      close_code: code,
      reason,
      reconnect_attempts: state.reconnectAttempts,
    });

    rejectAllPending(state, {
      code: 'DISCONNECTED',
      message: 'Bridge disconnected while command was running',
      details: {
        reason,
      },
      recovery: {
        reconnect_required: true,
        next_command: 'human-browser reconnect',
      },
    });
  });

  ws.on('error', (error) => {
    logEvent(state, 'error', 'bridge.socket_error', 'Bridge socket error', {
      error: error.message,
    });
  });
}

async function handleExtensionMessage(state: RuntimeState, raw: string): Promise<void> {
  let envelope: ExtensionToDaemonEnvelope;
  try {
    envelope = JSON.parse(raw) as ExtensionToDaemonEnvelope;
  } catch {
    logEvent(state, 'warn', 'bridge.invalid_json', 'Received invalid JSON from extension', { raw });
    return;
  }

  switch (envelope.type) {
    case 'HELLO': {
      logEvent(state, 'info', 'bridge.hello', 'Extension hello received', {
        version: envelope.version,
        retry_count: envelope.retry_count,
      });
      break;
    }
    case 'PONG': {
      state.lastPingAt = envelope.ts;
      break;
    }
    case 'EVENT': {
      if (envelope.name === 'dialog_opened') {
        state.dialog = toDialogState(envelope.payload);
      } else if (envelope.name === 'dialog_closed') {
        state.dialog = undefined;
      }
      logEvent(state, 'info', `extension.${envelope.name}`, `Extension event: ${envelope.name}`, envelope.payload);
      break;
    }
    case 'RESULT': {
      const pending = state.pendingCommands.get(envelope.request_id);
      if (!pending) {
        logEvent(state, 'warn', 'bridge.orphan_result', 'Result for unknown request_id', {
          request_id: envelope.request_id,
        });
        break;
      }

      clearTimeout(pending.timer);
      state.pendingCommands.delete(envelope.request_id);

      if (envelope.ok) {
        pending.resolve(envelope.result ?? {});
      } else {
        const extensionCode = envelope.error?.code;
        const extensionMessage = envelope.error?.message ?? 'Extension command failed';
        const extensionDetails = {
          extension_code: extensionCode,
          ...(envelope.error?.details ?? {}),
        };

        if (extensionCode === 'DIALOG_OPEN') {
          pending.reject({
            code: 'BAD_REQUEST',
            message: extensionMessage,
            details: extensionDetails,
            recovery: {
              next_command: 'human-browser dialog accept',
            },
          });
          break;
        }

        if (extensionCode === 'NO_OPEN_DIALOG') {
          pending.reject({
            code: 'BAD_REQUEST',
            message: extensionMessage,
            details: extensionDetails,
          });
          break;
        }

        pending.reject({
          code: 'EXTENSION_ERROR',
          message: extensionMessage,
          details: extensionDetails,
        });
      }
      break;
    }
    default: {
      logEvent(state, 'warn', 'bridge.unknown_message', 'Unknown message type from extension', {
        raw,
      });
    }
  }
}

function rejectAllPending(state: RuntimeState, error: StructuredError): void {
  for (const [, pending] of state.pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pendingCommands.clear();
}

function resolveConnectionWaiters(state: RuntimeState): void {
  for (const waiter of state.connectionWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
  state.connectionWaiters = [];
}

function rejectConnectionWaiters(state: RuntimeState, error: StructuredError): void {
  for (const waiter of state.connectionWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  state.connectionWaiters = [];
}

async function executeCommand(
  state: RuntimeState,
  command: string,
  args: Record<string, unknown>,
  options: { timeoutMs: number; queueMode: QueueMode },
): Promise<Record<string, unknown>> {
  switch (command) {
    case 'status': {
      return {
        extension: {
          connected: Boolean(state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN),
          connected_at: state.extensionConnectedAt,
          last_ping_at: state.lastPingAt,
          last_disconnect_reason: state.lastDisconnectReason,
          reconnect_attempts: state.reconnectAttempts,
        },
        session: {
          selected_tab_id: state.selectedTabId,
          latest_snapshot_id: state.latestSnapshot?.snapshot_id,
          dialog: state.dialog,
          recording: state.recording
            ? {
                active: state.recording.active,
                tab_id: state.recording.tabId,
                output_path: state.recording.outputPath,
                fps: state.recording.fps,
                frame_count: state.recording.frameCount,
                started_at: state.recording.startedAt,
                last_frame_at: state.recording.lastFrameAt,
                last_capture_error: state.recording.lastCaptureError,
              }
            : { active: false },
        },
      };
    }

    case 'tabs': {
      return sendBridgeCommand(state, 'list_tabs', {}, options);
    }

    case 'use': {
      const target = args.target;
      if (target === undefined) {
        throw new HBError('BAD_REQUEST', 'use command requires args.target');
      }
      if (target !== 'active') {
        const requestedTabId = parseRequestedTabId(target);
        if (requestedTabId !== null) {
          const tabsResult = await sendBridgeCommand(state, 'list_tabs', {}, options);
          const tabs = Array.isArray(tabsResult.tabs) ? tabsResult.tabs : [];
          const exists = tabs.some((tab) => {
            if (!tab || typeof tab !== 'object') {
              return false;
            }
            const id = Number((tab as { id?: unknown }).id);
            return Number.isFinite(id) && id === requestedTabId;
          });
          if (!exists) {
            throw new HBError('BAD_REQUEST', `No tab with given id ${requestedTabId}.`, {
              tab_id: requestedTabId,
            });
          }
        }
      }
      const result = await sendBridgeCommand(state, 'select_tab', { target }, options);
      const tabId = Number(result.tab_id);
      if (Number.isFinite(tabId)) {
        state.selectedTabId = tabId;
      }
      return {
        selected_tab_id: state.selectedTabId,
      };
    }

    case 'snapshot': {
      const target = args.target ?? state.selectedTabId ?? 'active';
      const snapshotOptions = getSnapshotOptions(args);
      const snapshot = await captureSnapshot(state, target, snapshotOptions, options);
      rememberSnapshot(state, snapshot);
      state.selectedTabId = snapshot.tab_id;

      return {
        snapshot_id: snapshot.snapshot_id,
        tab_id: snapshot.tab_id,
        tree: snapshot.tree,
        refs: snapshot.refs,
        created_at: snapshot.created_at,
      };
    }

    case 'diff_snapshot': {
      const baselinePath = typeof args.baseline === 'string' ? args.baseline : undefined;
      const beforeRaw = baselinePath
        ? await readBaselineSnapshotFile(baselinePath)
        : state.latestSnapshot?.tree;

      if (!beforeRaw) {
        throw new HBError(
          'BAD_REQUEST',
          'No previous snapshot in this session. Take a snapshot first, or use --baseline <file>.',
        );
      }

      const target = args.target ?? state.selectedTabId ?? 'active';
      const snapshotOptions = getSnapshotOptions(args);
      const currentSnapshot = await captureSnapshot(state, target, snapshotOptions, options);

      return diffSnapshotText(beforeRaw, currentSnapshot.tree);
    }

    case 'diff_screenshot': {
      const baselinePath = getStringField(args, 'baseline');
      const baselineBuffer = await readBaselineImageFile(baselinePath);

      const threshold = getOptionalThreshold(args.threshold);
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      const fullPage = Boolean(args.full_page);
      const outputPathRaw = typeof args.output === 'string' ? args.output : undefined;

      const tabId = resolveTabForAction(state, args);
      const screenshotResult = await sendBridgeCommand(
        state,
        'screenshot',
        {
          tab_id: tabId,
          selector,
          full_page: fullPage,
        },
        options,
      );
      const currentRawData = screenshotResult.data_base64;
      if (typeof currentRawData !== 'string' || currentRawData.length === 0) {
        throw new HBError('EXTENSION_ERROR', 'screenshot result is missing data_base64', {
          result: screenshotResult,
        });
      }

      const outputPath = outputPathRaw ? resolveOutputPathWithExt(outputPathRaw, '.png') : undefined;
      const ext = extname(baselinePath).toLowerCase();
      const baselineMime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      return diffImages(
        baselineBuffer,
        Buffer.from(currentRawData, 'base64'),
        {
          threshold,
          outputPath,
          baselineMime,
        },
      );
    }

    case 'diff_url': {
      const url1 = getStringField(args, 'url1');
      const url2 = getStringField(args, 'url2');
      const screenshotEnabled = Boolean(args.screenshot);
      const fullPage = Boolean(args.full_page);
      const waitUntil = getWaitUntil(args.wait_until);
      const snapshotOptions = getSnapshotOptions(args);
      const tabId = resolveTabForAction(state, args);

      await sendBridgeCommand(state, 'open', { tab_id: tabId, url: url1 }, options);
      await sendBridgeCommand(
        state,
        'wait',
        {
          tab_id: tabId,
          load_state: waitUntil,
          timeout_ms: options.timeoutMs,
        },
        options,
      );
      const snapshot1 = await captureSnapshot(state, tabId, snapshotOptions, options);
      let screenshot1: Buffer | undefined;
      if (screenshotEnabled) {
        const shot1 = await sendBridgeCommand(
          state,
          'screenshot',
          {
            tab_id: tabId,
            full_page: fullPage,
          },
          options,
        );
        const data = shot1.data_base64;
        if (typeof data !== 'string' || data.length === 0) {
          throw new HBError('EXTENSION_ERROR', 'screenshot result is missing data_base64', {
            result: shot1,
          });
        }
        screenshot1 = Buffer.from(data, 'base64');
      }

      await sendBridgeCommand(state, 'open', { tab_id: tabId, url: url2 }, options);
      await sendBridgeCommand(
        state,
        'wait',
        {
          tab_id: tabId,
          load_state: waitUntil,
          timeout_ms: options.timeoutMs,
        },
        options,
      );
      const snapshot2 = await captureSnapshot(state, tabId, snapshotOptions, options);
      rememberSnapshot(state, snapshot2);
      state.selectedTabId = snapshot2.tab_id;

      const snapshotDiff = diffSnapshotText(snapshot1.tree, snapshot2.tree);
      const response: Record<string, unknown> = {
        snapshot: snapshotDiff,
      };

      if (screenshotEnabled && screenshot1) {
        const shot2 = await sendBridgeCommand(
          state,
          'screenshot',
          {
            tab_id: tabId,
            full_page: fullPage,
          },
          options,
        );
        const data = shot2.data_base64;
        if (typeof data !== 'string' || data.length === 0) {
          throw new HBError('EXTENSION_ERROR', 'screenshot result is missing data_base64', {
            result: shot2,
          });
        }
        response.screenshot = await diffImages(
          screenshot1,
          Buffer.from(data, 'base64'),
          {},
        );
      }

      return response;
    }

    case 'click': {
      const target = resolveActionTarget(args, 'click');
      const explicitNth = getOptionalNth(args.nth);

      if (target.kind === 'ref') {
        const snapshotId = getRequiredSnapshotId(args, 'click');
        const snapshot = resolveSnapshotForAction(state, {
          ...args,
          snapshot_id: snapshotId,
        });
        const refData = snapshot.refs[target.ref];
        if (!refData) {
          throw new HBError('NO_SUCH_REF', `Ref not found: ${target.ref}`, {
            ref: target.ref,
            snapshot_id: snapshot.snapshot_id,
          }, {
            next_command: 'human-browser snapshot',
          });
        }

        const result = await sendBridgeCommand(
          state,
          'click',
          {
            tab_id: snapshot.tab_id,
            selector: refData.selector,
            nth: explicitNth,
          },
          options,
        );

        return {
          snapshot_id: snapshot.snapshot_id,
          tab_id: snapshot.tab_id,
          ref: target.ref,
          selector: refData.selector,
          nth: explicitNth,
          result,
        };
      }

      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'click',
        {
          tab_id: tabId,
          selector: target.selector,
          nth: explicitNth,
        },
        options,
      );

      return {
        tab_id: tabId,
        selector: target.selector,
        nth: explicitNth,
        result,
      };
    }

    case 'fill': {
      const value = getStringField(args, 'value');
      const target = resolveActionTarget(args, 'fill');
      const explicitNth = getOptionalNth(args.nth);

      if (target.kind === 'ref') {
        const snapshotId = getRequiredSnapshotId(args, 'fill');
        const snapshot = resolveSnapshotForAction(state, {
          ...args,
          snapshot_id: snapshotId,
        });
        const refData = snapshot.refs[target.ref];
        if (!refData) {
          throw new HBError('NO_SUCH_REF', `Ref not found: ${target.ref}`, {
            ref: target.ref,
            snapshot_id: snapshot.snapshot_id,
          }, {
            next_command: 'human-browser snapshot',
          });
        }

        const result = await sendBridgeCommand(
          state,
          'fill',
          {
            tab_id: snapshot.tab_id,
            selector: refData.selector,
            value,
            nth: explicitNth,
          },
          options,
        );

        return {
          snapshot_id: snapshot.snapshot_id,
          tab_id: snapshot.tab_id,
          ref: target.ref,
          selector: refData.selector,
          nth: explicitNth,
          result,
        };
      }

      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'fill',
        {
          tab_id: tabId,
          selector: target.selector,
          value,
          nth: explicitNth,
        },
        options,
      );

      return {
        tab_id: tabId,
        selector: target.selector,
        nth: explicitNth,
        result,
      };
    }

    case 'dialog': {
      const response = getStringField(args, 'response');
      if (response !== 'accept' && response !== 'dismiss') {
        throw new HBError('BAD_REQUEST', 'dialog requires args.response to be accept or dismiss');
      }

      const tabId = resolveTabForAction(state, args);
      const promptText = typeof args.prompt_text === 'string' ? args.prompt_text : undefined;
      const result = await sendBridgeCommand(
        state,
        'dialog',
        {
          tab_id: tabId,
          response,
          prompt_text: promptText,
        },
        options,
      );

      if (result.handled === true) {
        state.dialog = undefined;
      }

      return {
        tab_id: tabId,
        response,
        prompt_text: promptText,
        result,
      };
    }

    case 'keypress': {
      const key = getStringField(args, 'key');
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'keypress', { tab_id: tabId, key }, options);
      return {
        tab_id: tabId,
        key,
        result,
      };
    }

    case 'scroll': {
      const x = Number(args.x ?? 0);
      const y = Number(args.y ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new HBError('BAD_REQUEST', 'scroll requires numeric x and y');
      }
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'scroll', { tab_id: tabId, x, y }, options);
      return {
        tab_id: tabId,
        x,
        y,
        result,
      };
    }

    case 'navigate': {
      const url = getStringField(args, 'url');
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'navigate', { tab_id: tabId, url }, options);
      return {
        tab_id: tabId,
        url,
        result,
      };
    }

    case 'open': {
      const url = getStringField(args, 'url');
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'open', { tab_id: tabId, url }, options);
      return {
        tab_id: tabId,
        url,
        result,
      };
    }

    case 'close': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'close', { tab_id: tabId }, options);
      if (typeof state.selectedTabId === 'number' && state.selectedTabId === tabId) {
        state.selectedTabId = undefined;
      }
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'hover': {
      const target = resolveActionTarget(args, 'hover');
      const explicitNth = getOptionalNth(args.nth);

      if (target.kind === 'ref') {
        const snapshotId = getRequiredSnapshotId(args, 'hover');
        const snapshot = resolveSnapshotForAction(state, {
          ...args,
          snapshot_id: snapshotId,
        });
        const refData = snapshot.refs[target.ref];
        if (!refData) {
          throw new HBError('NO_SUCH_REF', `Ref not found: ${target.ref}`, {
            ref: target.ref,
            snapshot_id: snapshot.snapshot_id,
          }, {
            next_command: 'human-browser snapshot',
          });
        }

        const result = await sendBridgeCommand(
          state,
          'hover',
          {
            tab_id: snapshot.tab_id,
            selector: refData.selector,
            nth: explicitNth,
          },
          options,
        );

        return {
          snapshot_id: snapshot.snapshot_id,
          tab_id: snapshot.tab_id,
          ref: target.ref,
          selector: refData.selector,
          nth: explicitNth,
          result,
        };
      }

      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'hover',
        {
          tab_id: tabId,
          selector: target.selector,
          nth: explicitNth,
        },
        options,
      );

      return {
        tab_id: tabId,
        selector: target.selector,
        nth: explicitNth,
        result,
      };
    }

    case 'eval': {
      const script = getStringField(args, 'script');
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(state, 'eval', { tab_id: tabId, script }, options);
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'text': {
      const target = resolveReadTarget(state, args, 'text');
      const result = await sendBridgeCommand(
        state,
        'text',
        {
          tab_id: target.tabId,
          selector: target.selector,
          nth: target.nth,
        },
        options,
      );
      return {
        tab_id: target.tabId,
        selector: target.selector,
        nth: target.nth,
        result,
      };
    }

    case 'value': {
      const target = resolveReadTarget(state, args, 'value');
      const result = await sendBridgeCommand(
        state,
        'value',
        {
          tab_id: target.tabId,
          selector: target.selector,
          nth: target.nth,
        },
        options,
      );
      return {
        tab_id: target.tabId,
        selector: target.selector,
        nth: target.nth,
        result,
      };
    }

    case 'html': {
      const target = resolveReadTarget(state, args, 'html', true);
      const result = await sendBridgeCommand(
        state,
        'html',
        {
          tab_id: target.tabId,
          selector: target.selector,
          nth: target.nth,
        },
        options,
      );
      return {
        tab_id: target.tabId,
        selector: target.selector,
        nth: target.nth,
        result,
      };
    }

    case 'screenshot': {
      const tabId = resolveTabForAction(state, args);
      const fullPage = Boolean(args.full_page);
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      const result = await sendBridgeCommand(
        state,
        'screenshot',
        {
          tab_id: tabId,
          full_page: fullPage,
          selector,
        },
        options,
      );
      const rawData = result.data_base64;
      if (typeof rawData !== 'string' || rawData.length === 0) {
        throw new HBError('EXTENSION_ERROR', 'screenshot result is missing data_base64', { result });
      }
      const format = result.format === 'jpeg' ? 'jpeg' : 'png';
      const requestedPath = typeof args.path === 'string' ? args.path : undefined;
      const outputPath = requestedPath
        ? resolveOutputPathWithExt(requestedPath, format === 'jpeg' ? '.jpg' : '.png')
        : buildAutoScreenshotPath(format);
      await writeBase64File(outputPath, rawData);
      return {
        tab_id: tabId,
        full_page: fullPage,
        format,
        path: outputPath,
      };
    }

    case 'pdf': {
      const tabId = resolveTabForAction(state, args);
      const path = getStringField(args, 'path');
      const outputPath = resolveOutputPathWithExt(path, '.pdf');
      const result = await sendBridgeCommand(
        state,
        'pdf',
        {
          tab_id: tabId,
        },
        options,
      );
      const rawData = result.data_base64;
      if (typeof rawData !== 'string' || rawData.length === 0) {
        throw new HBError('EXTENSION_ERROR', 'pdf result is missing data_base64', { result });
      }
      await writeBase64File(outputPath, rawData);
      return {
        tab_id: tabId,
        path: outputPath,
      };
    }

    case 'wait': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'wait',
        {
          tab_id: tabId,
          ...args,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'cookies_get': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'cookies_get',
        {
          tab_id: tabId,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'cookies_set': {
      const tabId = resolveTabForAction(state, args);
      const name = getStringField(args, 'name');
      const value = getStringField(args, 'value');
      const url = typeof args.url === 'string' ? args.url : undefined;
      const result = await sendBridgeCommand(
        state,
        'cookies_set',
        {
          tab_id: tabId,
          name,
          value,
          url,
        },
        options,
      );
      return {
        tab_id: tabId,
        name,
        result,
      };
    }

    case 'cookies_delete': {
      const tabId = resolveTabForAction(state, args);
      const name = getStringField(args, 'name');
      const url = typeof args.url === 'string' ? args.url : undefined;
      const result = await sendBridgeCommand(
        state,
        'cookies_delete',
        {
          tab_id: tabId,
          name,
          url,
        },
        options,
      );
      return {
        tab_id: tabId,
        name,
        result,
      };
    }

    case 'cookies_clear': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        'cookies_clear',
        {
          tab_id: tabId,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'network_start':
    case 'network_stop': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        command,
        {
          tab_id: tabId,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'network_dump': {
      const tabId = resolveTabForAction(state, args);
      const filter = typeof args.filter === 'string' ? args.filter : undefined;
      const clear = Boolean(args.clear);
      const result = await sendBridgeCommand(
        state,
        'network_dump',
        {
          tab_id: tabId,
          filter,
          clear,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'console_start':
    case 'console_stop': {
      const tabId = resolveTabForAction(state, args);
      const result = await sendBridgeCommand(
        state,
        command,
        {
          tab_id: tabId,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'console_dump': {
      const tabId = resolveTabForAction(state, args);
      const clear = Boolean(args.clear);
      const result = await sendBridgeCommand(
        state,
        'console_dump',
        {
          tab_id: tabId,
          clear,
        },
        options,
      );
      return {
        tab_id: tabId,
        result,
      };
    }

    case 'record_start': {
      return startRecordingSession(state, args, options);
    }

    case 'record_stop': {
      if (!state.recording) {
        throw new HBError('BAD_REQUEST', 'No recording in progress. Run `human-browser record start <path.webm>` first.');
      }
      const recording = state.recording;
      state.recording = undefined;
      return stopRecordingSession(state, recording);
    }

    case 'record_restart': {
      let stopped: Record<string, unknown> | undefined;
      if (state.recording) {
        const previous = state.recording;
        state.recording = undefined;
        stopped = await stopRecordingSession(state, previous);
      }
      const started = await startRecordingSession(state, args, options);
      if (stopped) {
        return {
          stopped,
          started,
        };
      }
      return started;
    }

    case 'reconnect': {
      if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
        throw new HBError(
          'DISCONNECTED',
          'Extension is disconnected',
          {
            reason: state.lastDisconnectReason,
          },
          {
            reconnect_required: true,
            next_command: 'Open extension popup and press Reconnect',
          },
        );
      }
      const result = await sendBridgeCommand(state, 'reconnect', {}, options);
      return {
        requested: true,
        result,
      };
    }

    case 'reset': {
      state.latestSnapshot = undefined;
      state.dialog = undefined;
      state.snapshotById.clear();
      state.snapshotOrder = [];
      const extensionOnline = Boolean(
        state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN,
      );

      if (extensionOnline) {
        await sendBridgeCommand(state, 'reset', {}, options);
      }

      return {
        session_reset: true,
        extension_reset_requested: extensionOnline,
      };
    }

    case 'diagnose': {
      const limit = Number(args.limit ?? 50);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new HBError('BAD_REQUEST', 'diagnose requires a positive numeric limit');
      }
      return buildDiagnostics(state, limit) as unknown as Record<string, unknown>;
    }

    default:
      throw new HBError('BAD_REQUEST', `Unknown command: ${command}`);
  }
}

async function captureSnapshot(
  state: RuntimeState,
  target: number | 'active',
  snapshotOptions: SnapshotOptions,
  options: { timeoutMs: number; queueMode: QueueMode },
): Promise<SnapshotData> {
  const result = await sendBridgeCommand(
    state,
    'snapshot',
    {
      target,
      ...snapshotOptions,
    },
    options,
  );
  const tabId = Number(result.tab_id);
  const nodes = result.nodes as SnapshotNode[] | undefined;

  if (!Number.isFinite(tabId) || !Array.isArray(nodes)) {
    throw new HBError('EXTENSION_ERROR', 'snapshot result is missing tab_id or nodes', {
      result,
    });
  }

  return buildSnapshot(tabId, nodes);
}

async function readBaselineSnapshotFile(path: string): Promise<string> {
  let baseline: string;
  try {
    baseline = await readFile(path, 'utf8');
  } catch {
    throw new HBError('BAD_REQUEST', `Cannot read baseline file: ${path}`);
  }

  return normalizeSnapshotBaselineText(baseline);
}

function normalizeSnapshotBaselineText(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0) {
    return '';
  }
  const firstLine = lines[0] ?? '';
  if (/^snapshot_id=.* tab_id=.*$/.test(firstLine)) {
    return lines.slice(1).join('\n');
  }
  return lines.join('\n');
}

async function readBaselineImageFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new HBError('BAD_REQUEST', `Baseline file not found: ${path}`);
  }
}

function getOptionalThreshold(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new HBError('BAD_REQUEST', `Threshold must be between 0 and 1, got ${String(raw)}`);
  }
  return raw;
}

function getOptionalNth(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < -1) {
    throw new HBError('BAD_REQUEST', `nth must be an integer >= -1, got ${String(raw)}`);
  }
  return raw;
}

function getWaitUntil(raw: unknown): 'load' | 'domcontentloaded' | 'networkidle' {
  if (raw === undefined) {
    return 'load';
  }
  if (raw === 'load' || raw === 'domcontentloaded' || raw === 'networkidle') {
    return raw;
  }
  throw new HBError(
    'BAD_REQUEST',
    `wait_until must be one of load|domcontentloaded|networkidle, got ${String(raw)}`,
  );
}

function rememberSnapshot(state: RuntimeState, snapshot: SnapshotData): void {
  state.latestSnapshot = snapshot;

  if (state.snapshotById.has(snapshot.snapshot_id)) {
    state.snapshotOrder = state.snapshotOrder.filter((id) => id !== snapshot.snapshot_id);
  }

  state.snapshotById.set(snapshot.snapshot_id, snapshot);
  state.snapshotOrder.push(snapshot.snapshot_id);

  if (state.snapshotOrder.length <= MAX_SNAPSHOT_HISTORY) {
    return;
  }

  const removedSnapshotId = state.snapshotOrder.shift();
  if (!removedSnapshotId) {
    return;
  }
  state.snapshotById.delete(removedSnapshotId);
}

function resolveSnapshotForAction(state: RuntimeState, args: Record<string, unknown>): SnapshotData {
  const snapshot = state.latestSnapshot;
  if (!snapshot) {
    throw new HBError('NO_ACTIVE_SNAPSHOT', 'No active snapshot. Run snapshot first.', undefined, {
      next_command: 'human-browser snapshot',
    });
  }

  const requestedSnapshotId = typeof args.snapshot_id === 'string' ? args.snapshot_id : snapshot.snapshot_id;
  if (requestedSnapshotId !== snapshot.snapshot_id) {
    throw new HBError(
      'STALE_SNAPSHOT',
      `Snapshot mismatch. latest=${snapshot.snapshot_id}, requested=${requestedSnapshotId}`,
      {
        latest_snapshot_id: snapshot.snapshot_id,
        requested_snapshot_id: requestedSnapshotId,
      },
      {
        next_command: 'human-browser snapshot',
      },
    );
  }

  return snapshot;
}

function resolveTabForAction(state: RuntimeState, args: Record<string, unknown>): number | 'active' {
  const explicit = args.tab_id;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit;
  }

  if (typeof explicit === 'string') {
    if (explicit === 'active') {
      return 'active';
    }
    const parsed = Number(explicit);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (typeof state.selectedTabId === 'number') {
    return state.selectedTabId;
  }

  if (state.latestSnapshot) {
    return state.latestSnapshot.tab_id;
  }

  return 'active';
}

function resolveActionTarget(
  args: Record<string, unknown>,
  command: 'click' | 'fill' | 'hover',
): { kind: 'ref'; ref: string } | { kind: 'selector'; selector: string } {
  const refRaw = typeof args.ref === 'string' ? args.ref : undefined;
  const selectorRaw = typeof args.selector === 'string' ? args.selector : undefined;

  if (refRaw && selectorRaw) {
    throw new HBError('BAD_REQUEST', `${command} supports either args.ref or args.selector, not both`);
  }

  if (refRaw) {
    const ref = parseRefArg(refRaw);
    if (!ref) {
      throw new HBError('BAD_REQUEST', `Invalid ref format for ${command}: ${refRaw}`);
    }
    return { kind: 'ref', ref };
  }

  if (selectorRaw) {
    const selectorAsRef = parseRefArg(selectorRaw);
    if (selectorAsRef) {
      return { kind: 'ref', ref: selectorAsRef };
    }
    return { kind: 'selector', selector: selectorRaw };
  }

  throw new HBError('BAD_REQUEST', `${command} requires args.ref or args.selector`);
}

function getRequiredSnapshotId(args: Record<string, unknown>, command: 'click' | 'fill' | 'hover' | 'text' | 'value' | 'html'): string {
  const snapshotId = args.snapshot_id;
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new HBError('BAD_REQUEST', `${command} with ref requires args.snapshot_id`, undefined, {
      next_command: 'human-browser snapshot',
    });
  }
  return snapshotId;
}

function parseRefArg(raw: string): string | null {
  if (/^@e\d+$/.test(raw)) {
    return raw.slice(1);
  }

  if (/^ref=e\d+$/.test(raw)) {
    return raw.slice(4);
  }

  if (/^e\d+$/.test(raw)) {
    return raw;
  }

  return null;
}

function resolveReadTarget(
  state: RuntimeState,
  args: Record<string, unknown>,
  command: 'text' | 'value' | 'html',
  allowEmptySelector = false,
): { tabId: number | 'active'; selector?: string; nth?: number } {
  const refRaw = typeof args.ref === 'string' ? args.ref : undefined;
  const selectorRaw = typeof args.selector === 'string' ? args.selector : undefined;
  const explicitNth = getOptionalNth(args.nth);

  if (refRaw && selectorRaw) {
    throw new HBError('BAD_REQUEST', `${command} supports either args.ref or args.selector, not both`);
  }

  if (refRaw) {
    const parsedRef = parseRefArg(refRaw);
    if (!parsedRef) {
      throw new HBError('BAD_REQUEST', `Invalid ref format for ${command}: ${refRaw}`);
    }
    const snapshotId = getRequiredSnapshotId(args, command);
    const snapshot = resolveSnapshotForAction(state, {
      ...args,
      snapshot_id: snapshotId,
    });
    const refData = snapshot.refs[parsedRef];
    if (!refData) {
      throw new HBError('NO_SUCH_REF', `Ref not found: ${parsedRef}`, {
        ref: parsedRef,
        snapshot_id: snapshot.snapshot_id,
      }, {
        next_command: 'human-browser snapshot',
      });
    }
    return {
      tabId: snapshot.tab_id,
      selector: refData.selector,
      nth: explicitNth,
    };
  }

  if (selectorRaw) {
    const selectorAsRef = parseRefArg(selectorRaw);
    if (selectorAsRef) {
      const snapshotId = getRequiredSnapshotId(args, command);
      const snapshot = resolveSnapshotForAction(state, {
        ...args,
        snapshot_id: snapshotId,
      });
      const refData = snapshot.refs[selectorAsRef];
      if (!refData) {
        throw new HBError('NO_SUCH_REF', `Ref not found: ${selectorAsRef}`, {
          ref: selectorAsRef,
          snapshot_id: snapshot.snapshot_id,
        }, {
          next_command: 'human-browser snapshot',
        });
      }
      return {
        tabId: snapshot.tab_id,
        selector: refData.selector,
        nth: explicitNth,
      };
    }
    return {
      tabId: resolveTabForAction(state, args),
      selector: selectorRaw,
      nth: explicitNth,
    };
  }

  if (allowEmptySelector) {
    return {
      tabId: resolveTabForAction(state, args),
    };
  }

  throw new HBError('BAD_REQUEST', `${command} requires args.ref or args.selector`);
}

function resolveOutputPathWithExt(inputPath: string, fallbackExt: string): string {
  const absolute = resolve(inputPath);
  const extension = extname(absolute);
  if (extension.length > 0) {
    return absolute;
  }
  return `${absolute}${fallbackExt}`;
}

function buildAutoScreenshotPath(format: 'png' | 'jpeg'): string {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return join(homedir(), '.human-browser', 'tmp', 'screenshots', `screenshot-${timestamp}-${random}.${ext}`);
}

async function writeBase64File(path: string, base64: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(base64, 'base64'));
}

async function startRecordingSession(
  state: RuntimeState,
  args: Record<string, unknown>,
  options: { timeoutMs: number; queueMode: QueueMode },
): Promise<Record<string, unknown>> {
  if (state.recording) {
    throw new HBError('BAD_REQUEST', 'Recording already in progress. Run `human-browser record stop` first.');
  }

  const outputPath = resolveRecordingOutputPath(getStringField(args, 'path'));
  const outputExists = await pathExists(outputPath);
  if (outputExists) {
    throw new HBError('BAD_REQUEST', `Output file already exists: ${outputPath}`);
  }

  const fps = getRecordingFps(args.fps);
  const target = resolveTabForAction(state, args);
  const selected = await sendBridgeCommand(
    state,
    'select_tab',
    { target },
    options,
  );
  const tabId = Number(selected.tab_id);
  if (!Number.isFinite(tabId)) {
    throw new HBError('EXTENSION_ERROR', 'select_tab result is missing tab_id', { result: selected });
  }

  const frameDir = buildAutoRecordingFrameDir();
  await mkdir(frameDir, { recursive: true });

  const recording: RecordingSession = {
    tabId,
    outputPath,
    frameDir,
    fps,
    frameCount: 0,
    startedAt: new Date().toISOString(),
    active: true,
    stopping: false,
    queueMode: options.queueMode,
    timeoutMs: options.timeoutMs,
  };
  state.recording = recording;
  state.selectedTabId = tabId;

  try {
    await captureRecordingFrame(state, recording);
  } catch (error) {
    state.recording = undefined;
    throw error;
  }

  const intervalMs = Math.max(1, Math.floor(1000 / fps));
  recording.timer = setInterval(() => {
    void captureRecordingFrame(state, recording).catch(() => {
      // captureRecordingFrame persists structured error in recording.lastCaptureError.
    });
  }, intervalMs);

  return {
    tab_id: tabId,
    output_path: outputPath,
    fps,
    frame_dir: frameDir,
    frame_count: recording.frameCount,
    started_at: recording.startedAt,
    active: recording.active,
  };
}

async function stopRecordingSession(
  state: RuntimeState,
  recording: RecordingSession,
): Promise<Record<string, unknown>> {
  recording.stopping = true;
  recording.active = false;

  if (recording.timer) {
    clearInterval(recording.timer);
    recording.timer = undefined;
  }

  if (recording.captureInFlight) {
    try {
      await recording.captureInFlight;
    } catch {
      // Error details are persisted in recording.lastCaptureError by captureRecordingFrame.
    }
  }

  if (recording.frameCount === 0) {
    if (recording.lastCaptureError) {
      throw new HBError(
        recording.lastCaptureError.code,
        recording.lastCaptureError.message,
        recording.lastCaptureError.details,
        recording.lastCaptureError.recovery,
      );
    }
    throw new HBError('BAD_REQUEST', 'No frames were captured during recording.');
  }

  await encodeRecordingWithFfmpeg(recording);
  const stoppedAt = new Date().toISOString();

  const response: Record<string, unknown> = {
    tab_id: recording.tabId,
    output_path: recording.outputPath,
    fps: recording.fps,
    frames: recording.frameCount,
    frame_dir: recording.frameDir,
    started_at: recording.startedAt,
    stopped_at: stoppedAt,
  };

  if (recording.lastCaptureError) {
    response.capture_error = recording.lastCaptureError;
  }

  if (state.recording === recording) {
    state.recording = undefined;
  }

  return response;
}

async function captureRecordingFrame(state: RuntimeState, recording: RecordingSession): Promise<void> {
  if (recording.stopping) {
    return;
  }

  if (recording.captureInFlight) {
    return recording.captureInFlight;
  }

  const capturePromise = (async () => {
    try {
      const result = await sendBridgeCommand(
        state,
        'screenshot',
        {
          tab_id: recording.tabId,
          full_page: false,
        },
        {
          timeoutMs: recording.timeoutMs,
          queueMode: recording.queueMode,
        },
      );
      const rawData = result.data_base64;
      if (typeof rawData !== 'string' || rawData.length === 0) {
        throw new HBError('EXTENSION_ERROR', 'screenshot result is missing data_base64', { result });
      }

      recording.frameCount += 1;
      const framePath = join(recording.frameDir, `frame-${String(recording.frameCount).padStart(6, '0')}.png`);
      await writeBase64File(framePath, rawData);
      recording.lastFrameAt = new Date().toISOString();
    } catch (error) {
      const structured = asStructuredError(error);
      recording.lastCaptureError = structured;
      recording.active = false;
      if (recording.timer) {
        clearInterval(recording.timer);
        recording.timer = undefined;
      }
      throw new HBError(structured.code, structured.message, structured.details, structured.recovery);
    }
  })();

  recording.captureInFlight = capturePromise;
  try {
    await capturePromise;
  } finally {
    if (recording.captureInFlight === capturePromise) {
      recording.captureInFlight = undefined;
    }
  }
}

function resolveRecordingOutputPath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const extension = extname(absolute).toLowerCase();
  if (!extension) {
    return `${absolute}.webm`;
  }
  if (extension !== '.webm') {
    throw new HBError('BAD_REQUEST', 'record output path must use .webm extension');
  }
  return absolute;
}

function getRecordingFps(raw: unknown): number {
  if (raw === undefined) {
    return 5;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > 30) {
    throw new HBError('BAD_REQUEST', 'record fps must be an integer between 1 and 30');
  }
  return raw;
}

function buildAutoRecordingFrameDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return join(homedir(), '.human-browser', 'tmp', 'recordings', `recording-${timestamp}-${random}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function encodeRecordingWithFfmpeg(recording: RecordingSession): Promise<void> {
  await mkdir(dirname(recording.outputPath), { recursive: true });
  const ffmpegCommand = await resolveFfmpegCommand();
  const inputPattern = join(recording.frameDir, 'frame-%06d.png');
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(recording.fps),
    '-i',
    inputPattern,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    recording.outputPath,
  ];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegCommand, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        rejectPromise(
          new HBError(
            'BAD_REQUEST',
            'ffmpeg command not found. Install ffmpeg or set HUMAN_BROWSER_FFMPEG_PATH.',
          ),
        );
        return;
      }
      rejectPromise(
        new HBError('INTERNAL', 'Failed to start ffmpeg process', {
          error: error.message,
        }),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new HBError('INTERNAL', 'ffmpeg failed to encode recording', {
          ffmpeg_command: ffmpegCommand,
          exit_code: code,
          stderr: stderr.trim().slice(-4000),
        }),
      );
    });
  });
}

async function resolveFfmpegCommand(): Promise<string> {
  const envCommand = typeof process.env.HUMAN_BROWSER_FFMPEG_PATH === 'string'
    ? process.env.HUMAN_BROWSER_FFMPEG_PATH.trim()
    : '';
  if (envCommand) {
    if (!envCommand.includes('/')) {
      return envCommand;
    }
    if (await isExecutableFile(envCommand)) {
      return envCommand;
    }
    throw new HBError(
      'BAD_REQUEST',
      `HUMAN_BROWSER_FFMPEG_PATH is not executable: ${envCommand}`,
    );
  }

  const absoluteCandidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const candidate of absoluteCandidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return 'ffmpeg';
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sendBridgeCommand(
  state: RuntimeState,
  command: string,
  payload: Record<string, unknown>,
  options: { timeoutMs: number; queueMode: QueueMode },
): Promise<Record<string, unknown>> {
  await ensureBridgeConnected(state, options.timeoutMs, options.queueMode);

  if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
    throw new HBError('DISCONNECTED', 'Bridge disconnected before command dispatch', undefined, {
      reconnect_required: true,
      next_command: 'human-browser reconnect',
    });
  }

  const requestId = randomUUID();

  let result: Record<string, unknown>;
  try {
    result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingCommands.delete(requestId);
        reject(
          new HBError(
            'TIMEOUT',
            `Extension timeout while executing command: ${command}`,
            {
              phase: 'extension_response',
              command,
              timeout_ms: options.timeoutMs,
            },
            {
              next_command: 'human-browser diagnose',
            },
          ).structured,
        );
      }, options.timeoutMs);

      const pending: PendingCommand = {
        requestId,
        command,
        resolve,
        reject: (structuredError) => reject(structuredError),
        timer,
      };

      state.pendingCommands.set(requestId, pending);

      state.extensionSocket?.send(
        JSON.stringify({
          type: 'COMMAND',
          request_id: requestId,
          command,
          payload,
        }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            state.pendingCommands.delete(requestId);
            reject(
              new HBError('DISCONNECTED', 'Failed to send command to extension', {
                command,
                error: error.message,
              }).structured,
            );
          }
        },
      );
    });
  } catch (error) {
    maybeClearSelectedTabForMissingTabError(state, payload, error);
    throw error;
  }

  logEvent(state, 'info', 'bridge.command_ok', `Bridge command succeeded: ${command}`, {
    command,
    request_id: requestId,
  });

  return result;
}

function parseRequestedTabId(target: unknown): number | null {
  if (typeof target === 'number' && Number.isFinite(target)) {
    return target;
  }
  if (typeof target === 'string') {
    const parsed = Number(target);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function maybeClearSelectedTabForMissingTabError(
  state: RuntimeState,
  payload: Record<string, unknown>,
  error: unknown,
): void {
  const targetTabId = payload.tab_id;
  if (typeof targetTabId !== 'number' || !Number.isFinite(targetTabId)) {
    return;
  }
  if (state.selectedTabId !== targetTabId) {
    return;
  }
  if (!error || typeof error !== 'object') {
    return;
  }
  const structured = error as { code?: unknown; message?: unknown; details?: Record<string, unknown> };
  if (structured.code !== 'EXTENSION_ERROR') {
    return;
  }
  const extensionCode = structured.details?.extension_code;
  const isMissingTabCode = extensionCode === 'NO_SUCH_TAB' || extensionCode === 'DEBUGGER_ATTACH_FAILED';
  const message = typeof structured.message === 'string' ? structured.message : '';
  if (!isMissingTabCode || !message.includes('No tab with given id')) {
    return;
  }
  state.selectedTabId = undefined;
}

async function ensureBridgeConnected(state: RuntimeState, timeoutMs: number, queueMode: QueueMode): Promise<void> {
  if (state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN) {
    return;
  }

  if (queueMode === 'fail') {
    throw new HBError('DISCONNECTED', 'Extension is disconnected', {
      reason: state.lastDisconnectReason,
    }, {
      reconnect_required: true,
      next_command: 'human-browser reconnect',
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.connectionWaiters = state.connectionWaiters.filter((entry) => entry !== waiter);
      reject(
        new HBError(
          'TIMEOUT',
          'Timed out while waiting for extension to reconnect',
          {
            phase: 'wait_for_extension',
            timeout_ms: timeoutMs,
          },
          {
            reconnect_required: true,
            next_command: 'human-browser diagnose',
          },
        ),
      );
    }, timeoutMs);

    const waiter: ConnectionWaiter = {
      resolve,
      reject: (structuredError) => reject(structuredError),
      timer,
    };

    state.connectionWaiters.push(waiter);
  });
}

function buildDiagnostics(state: RuntimeState, limit: number): DiagnosticsReport {
  const normalized = Math.max(1, Math.floor(limit));
  return {
    now: new Date().toISOString(),
    extension: {
      connected: Boolean(state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN),
      connected_at: state.extensionConnectedAt,
      last_ping_at: state.lastPingAt,
      last_disconnect_reason: state.lastDisconnectReason,
    },
    session: {
      selected_tab_id: state.selectedTabId,
      latest_snapshot_id: state.latestSnapshot?.snapshot_id,
      dialog: state.dialog,
    },
    events: state.events.slice(-normalized),
    disconnect_history: state.disconnectHistory.slice(-normalized),
    reconnect_history: state.reconnectHistory.slice(-normalized),
  };
}

function truncateHistory(state: RuntimeState): void {
  const maxEvents = state.config.diagnostics.max_events;
  if (state.events.length > maxEvents) {
    state.events = state.events.slice(-maxEvents);
  }

  if (state.disconnectHistory.length > maxEvents) {
    state.disconnectHistory = state.disconnectHistory.slice(-maxEvents);
  }

  if (state.reconnectHistory.length > maxEvents) {
    state.reconnectHistory = state.reconnectHistory.slice(-maxEvents);
  }
}

function logEvent(
  state: RuntimeState,
  level: DaemonEvent['level'],
  kind: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  state.events.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    level,
    kind,
    message,
    details,
  });

  truncateHistory(state);
}

function toDialogState(payload: Record<string, unknown> | undefined): DialogState | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  return {
    open: true,
    type: typeof payload.type === 'string' ? payload.type : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
    default_prompt: typeof payload.default_prompt === 'string' ? payload.default_prompt : undefined,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    opened_at: typeof payload.opened_at === 'string' ? payload.opened_at : undefined,
  };
}

function sendJson(res: ServerResponse, status: number, payload: DaemonApiResponse | Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HBError('BAD_REQUEST', 'Request body must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new HBError('BAD_REQUEST', 'Request body must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function getStringField(
  input: Record<string, unknown>,
  field: string,
  fallback?: string,
): string {
  const value = input[field];
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new HBError('BAD_REQUEST', `Field must be a non-empty string: ${field}`);
  }

  return value;
}

function getObjectField(
  input: Record<string, unknown>,
  field: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HBError('BAD_REQUEST', `Field must be an object: ${field}`);
  }

  return value as Record<string, unknown>;
}

function getNumberField(input: Record<string, unknown>, field: string, fallback: number): number {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HBError('BAD_REQUEST', `Field must be a positive number: ${field}`);
  }

  return value;
}

function getSnapshotOptions(args: Record<string, unknown>): SnapshotOptions {
  const snapshotOptions: SnapshotOptions = {};

  const interactive = args.interactive;
  if (interactive !== undefined) {
    if (typeof interactive !== 'boolean') {
      throw new HBError('BAD_REQUEST', 'Field must be a boolean: interactive');
    }
    snapshotOptions.interactive = interactive;
  }

  const cursor = args.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== 'boolean') {
      throw new HBError('BAD_REQUEST', 'Field must be a boolean: cursor');
    }
    snapshotOptions.cursor = cursor;
  }

  const compact = args.compact;
  if (compact !== undefined) {
    if (typeof compact !== 'boolean') {
      throw new HBError('BAD_REQUEST', 'Field must be a boolean: compact');
    }
    snapshotOptions.compact = compact;
  }

  const depth = args.depth;
  if (depth !== undefined) {
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) {
      throw new HBError('BAD_REQUEST', 'Field must be a non-negative integer: depth');
    }
    snapshotOptions.depth = depth;
  }

  const selector = args.selector;
  if (selector !== undefined) {
    if (typeof selector !== 'string' || selector.length === 0) {
      throw new HBError('BAD_REQUEST', 'Field must be a non-empty string: selector');
    }
    snapshotOptions.selector = selector;
  }

  return snapshotOptions;
}

function getQueueMode(input: Record<string, unknown>, field: string, fallback: QueueMode): QueueMode {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }

  if (value === 'hold' || value === 'fail') {
    return value;
  }

  throw new HBError('BAD_REQUEST', `Field must be 'hold' or 'fail': ${field}`);
}
