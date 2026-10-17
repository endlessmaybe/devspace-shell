import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAppToolRateLimit } from './new-app-tool-admission.mjs';

const PIPE_DIR = '\\\\.\\pipe\\';
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
// The recovery path uses these known public app tools. Loading every installed
// tool through tools/list made local dispatch depend on remote catalog discovery.
const localCatalog = JSON.parse(readFileSync(new URL('./app-tools-local.json', import.meta.url), 'utf8'));
if (localCatalog.version !== 1 || localCatalog.namespace !== 'codex_app' ||
    !Array.isArray(localCatalog.tools) || localCatalog.tools.length !== 3 ||
    !['read_thread','list_archived_threads','send_message_to_thread'].every(name=>localCatalog.tools.includes(name))) {
  throw new Error('Invalid local app recovery tool registry');
}
const localTools = new Set(localCatalog.tools);

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) throw new Error('Codex app tool request is too large');
  const result = Buffer.allocUnsafe(payload.length + 4);
  result.writeUInt32LE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function withNativePipe(pipePath, callback) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let input = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    let settled = false;
    // Connection and each RPC have their own deadline. Archive pagination must
    // not consume the deadline reserved for the eventual send acknowledgement.
    const timer = setTimeout(() => finish(new Error('Codex app tool pipe connection timed out')), REQUEST_TIMEOUT_MS);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.fail(error || new Error('Codex app tool pipe closed'));
      }
      pending.clear();
      if (error) reject(error); else resolve(value);
    };
    const request = (method, params) => new Promise((done, fail) => {
      if (settled) return fail(new Error('Codex app tool pipe is closed'));
      let bytes;
      const id = nextId++;
      try { bytes = frame({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { fail(error); return; }
      const requestTimer = setTimeout(() => finish(new Error(`Codex app ${method} RPC timed out`)), REQUEST_TIMEOUT_MS);
      pending.set(id, { done, fail, timer: requestTimer });
      socket.write(bytes, error => { if (error) finish(error); });
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      Promise.resolve().then(() => callback(request)).then(value => finish(null, value), finish);
    });
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (length > MAX_FRAME_BYTES) return finish(new Error('Codex app tool response is too large'));
        if (input.length < length + 4) return;
        const payload = input.subarray(4, length + 4);
        input = input.subarray(length + 4);
        let message;
        try { message = JSON.parse(payload.toString('utf8')); }
        catch { return finish(new Error('Codex app tool response is invalid')); }
        const waiting = pending.get(Number(message.id));
        if (!waiting) continue;
        pending.delete(Number(message.id));
        clearTimeout(waiting.timer);
        if (message.error) {
          const error=new Error(message.error.message || 'Codex app tool failed');
          error.code=message.error.code;
          waiting.fail(error);
        }
        else waiting.done(message.result);
      }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('Codex app tool pipe closed'));
    });
  });
}

function toolText(result) {
  if (!result?.success) {
    const message = result?.contentItems?.find(item => item.type === 'inputText')?.text;
    throw new Error(String(message || 'Codex app tool returned an error'));
  }
  const raw = result.contentItems?.find(item => item.type === 'inputText')?.text;
  if (!raw) throw new Error('Codex app tool returned no text');
  return JSON.parse(raw);
}

async function appToolRequest(request, callerThreadId, tool, args, callId = randomUUID()) {
  if (!localTools.has(tool)) throw new Error('App tool is not registered in the local recovery catalog');
  try { return await request('tools/call', {
    namespace: localCatalog.namespace, tool, arguments: args, callerSource: 'codex',
    threadId: callerThreadId,
    turnId: `devspace-background-${Date.now().toString(36)}`,
    callId,
  }); } catch(error) {
    error.appTool=tool; error.stage=`app_tool:${tool}`; error.callId=callId;
    throw error;
  }
}

async function readExecutor(request, callerThreadId, destinationThreadId, options = {}) {
  const observed = await appToolJsonRequest(request, callerThreadId, 'read_thread', {
    threadId: destinationThreadId, turnLimit: 1, maxOutputCharsPerItem: 100, ...options,
  });
  if (observed?.thread?.id !== destinationThreadId || observed.thread.kind !== 'chatgpt') {
    throw new Error('Codex app returned a different executor conversation');
  }
  return observed;
}

async function appToolJsonRequest(request,callerThreadId,tool,args,callId=randomUUID()) {
  try{return toolText(await appToolRequest(request,callerThreadId,tool,args,callId));}
  catch(error){error.appTool=tool;error.stage=`app_tool:${tool}`;error.callId=callId;throw error;}
}

export function candidatePipes({ environment = process.env, readPipes = () => readdirSync(PIPE_DIR) } = {}) {
  const paths = [];
  if (environment.CODEX_APP_TOOLS_PIPE_PATH) paths.push(environment.CODEX_APP_TOOLS_PIPE_PATH);
  // Scheduled tasks do not inherit the desktop app's per-run environment. The
  // app tools now have their own pipe; browser-use pipes can lack tools/call.
  // Prefer the current app-tool bridge, retaining older app compatibility.
  try {
    const names = readPipes();
    for (const prefix of ['codex-app-tools-', 'codex-browser-use-']) {
      for (const name of names) if (name.startsWith(prefix)) paths.push(PIPE_DIR + name);
    }
  } catch {}
  return [...new Set(paths)];
}

export async function sendArchivedChatgptMessage({ callerThreadId, destinationThreadId, prompt, callId = randomUUID() }, {
  discoverPipes = candidatePipes,
  withPipe = withNativePipe,
} = {}) {
  if (!callerThreadId || !destinationThreadId || !prompt) throw new Error('Missing new-app dispatch configuration');
  const paths = [...new Set(discoverPipes())];
  if (!paths.length) throw new Error('Codex app tool pipe is unavailable');
  let lastError;
  const failures = [];
  const attempts = [];
  for (const pipePath of paths) {
    let sendIssued = false;
    try {
      return await withPipe(pipePath, async request => {
        // Verify the exact destination through the known read-only public tool,
        // without any global tool listing or plugin discovery.
        const probe = await readExecutor(request, callerThreadId, destinationThreadId);
        if (probe.thread.status?.type === 'active') return { sent: false, alreadyResponding: true };
        let cursor;
        let archived = false;
        const cursors = new Set();
        // Follow all pages, with explicit corruption/resource guards rather
        // than reporting a target after page five as "not archived".
        for (let page = 0; ; page++) {
          if (page >= 1000) throw new Error('Codex app archive pagination exceeded its safety limit');
          const listing = await appToolJsonRequest(request, callerThreadId, 'list_archived_threads', {
            source: 'chatgpt', limit: 50, ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(listing?.threads)) throw new Error('Codex app archive listing is invalid');
          if (listing.threads.some(thread => thread?.id === destinationThreadId)) { archived = true; break; }
          const next = listing.nextCursor;
          if (next === undefined || next === null || next === '') break;
          if (typeof next !== 'string' || !next.trim() || cursors.has(next)) {
            throw new Error('Codex app archive pagination cursor is invalid or repeated');
          }
          cursors.add(next);
          cursor = next;
        }
        if (!archived) throw new Error('The dedicated ChatGPT executor conversation is not archived');
        // Archive pagination may take time. Recheck activity immediately before
        // the non-idempotent send, preserving a reply that started meanwhile.
        const observed = await readExecutor(request, callerThreadId, destinationThreadId);
        const status = observed.thread.status?.type;
        if (status === 'active') return { sent: false, alreadyResponding: true };
        if (!['idle', 'systemError'].includes(status)) {
          throw new Error(`Archived ChatGPT executor status is unavailable (${String(status)})`);
        }
        // From this point a timeout/disconnect may mean the app accepted the
        // message. Never try another pipe after issuing this non-idempotent RPC.
        sendIssued = true;
        const sent = await appToolRequest(request, callerThreadId, 'send_message_to_thread', {
          threadId: destinationThreadId, prompt,
        }, callId);
        if (sent?.success === false) {
          const detail = sent?.contentItems?.find(item => item.type === 'inputText')?.text;
          if (String(detail || '').includes('is already responding')) return { sent: false, alreadyResponding: true };
          const refused = new Error(`Codex app refused to send to the archived executor conversation: ${String(detail || 'unknown').slice(0, 500)}`);
          refused.code = 'DEVSPACE_NEW_APP_SEND_REFUSED';
          refused.deliveryState = 'refused';
          refused.callId = callId;
          refused.stage = 'app_tool:send_message_to_thread';
          refused.appTool = 'send_message_to_thread';
          throw refused;
        }
        if (sent?.success !== true) throw new Error('Codex app returned no definitive send acknowledgement');
        return { sent: true };
      });
    } catch (error) {
      if (sendIssued) {
        if (error?.code === 'DEVSPACE_NEW_APP_SEND_REFUSED') throw error;
        const unknown = new Error(`New-app message delivery is unknown; do not automatically resend (callId=${callId}): ${error?.message || error}`, { cause: error });
        unknown.code = 'DEVSPACE_NEW_APP_SEND_UNKNOWN';
        unknown.deliveryState = 'unknown';
        unknown.callId = callId;
        unknown.stage = 'app_tool:send_message_to_thread';
        unknown.appTool = 'send_message_to_thread';
        throw unknown;
      }
      lastError = error;
      // This response came from a usable app tool. Another local pipe cannot
      // bypass its upstream cooldown and must not receive another request.
      if (isAppToolRateLimit(error)) throw error;
      failures.push(`${pipePath.split('\\').at(-1)}: ${error.message}`);
      attempts.push({pipe:pipePath.split('\\').at(-1),error});
    }
  }
  const unavailable=new Error(failures.join('; ') || lastError?.message || 'No usable Codex app tool pipe found',{cause:lastError});
  unavailable.code='DEVSPACE_NEW_APP_PIPE_UNAVAILABLE'; unavailable.stage=lastError?.stage||'pipe_connect'; unavailable.attempts=attempts;
  throw unavailable;
}

export async function readArchivedChatgptThread({ callerThreadId, destinationThreadId, turnLimit = 4 }, {
  discoverPipes = candidatePipes, withPipe = withNativePipe,
} = {}) {
  if (!callerThreadId || !destinationThreadId) throw new Error('Missing new-app read configuration');
  const failures = [];
  const attempts = [];
  for (const pipePath of [...new Set(discoverPipes())]) {
    try {
      return await withPipe(pipePath, async request => {
        return readExecutor(request, callerThreadId, destinationThreadId, {
          turnLimit, includeOutputs: true, maxOutputCharsPerItem: 20000,
        });
      });
    } catch (error) {
      if (isAppToolRateLimit(error)) throw error;
      failures.push(error.message); attempts.push({pipe:pipePath.split('\\').at(-1),error});
    }
  }
  const error=new Error(failures.join('; ') || 'No usable Codex app read pipe found',{cause:attempts.at(-1)?.error});
  error.code='DEVSPACE_NEW_APP_READ_UNAVAILABLE'; error.stage=attempts.at(-1)?.error?.stage||'pipe_connect'; error.attempts=attempts;
  throw error;
}
