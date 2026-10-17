import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePipes, sendArchivedChatgptMessage } from '../src/adapters/desktop-pipe.mjs';

test('bridge is rediscovered after desktop app restart without inherited environment', () => {
  assert.deepEqual(candidatePipes({ environment: {}, readPipes: () => ['unrelated', 'codex-browser-use-legacy', 'codex-app-tools-current'] }), ['\\\\.\\pipe\\codex-app-tools-current', '\\\\.\\pipe\\codex-browser-use-legacy']);
});
function fakePipe({ unknown = false, rateLimit = false, archive = true, wrongTarget = false } = {}, calls) {
  return async (_path, callback) => callback(async (_method, params) => {
    calls.push(params.tool);
    if (rateLimit) throw new Error('HTTP 429 Too Many Requests');
    if (params.tool === 'send_message_to_thread') { if (unknown) throw new Error('Disconnected after send'); return { success: true }; }
    const data = params.tool === 'read_thread' ? { thread: { id: wrongTarget ? 'wrong' : 'target', kind: 'chatgpt', status: { type: 'idle' } } } : { threads: archive ? [{ id: 'target' }] : [] };
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
  });
}
const request = { callerThreadId: 'caller', destinationThreadId: 'target', prompt: 'explicitly configured task' };
test('archived target and fresh idle state are checked before exactly one send', async () => {
  const calls = []; assert.equal((await sendArchivedChatgptMessage(request, { discoverPipes: () => ['test'], withPipe: fakePipe({}, calls) })).sent, true);
  assert.deepEqual(calls, ['read_thread', 'list_archived_threads', 'read_thread', 'send_message_to_thread']);
});
test('unknown delivery never retries another pipe', async () => {
  const calls = [];
  await assert.rejects(sendArchivedChatgptMessage(request, { discoverPipes: () => ['first', 'second'], withPipe: fakePipe({ unknown: true }, calls) }), error => error.deliveryState === 'unknown');
  assert.equal(calls.filter(c => c === 'send_message_to_thread').length, 1);
});
test('upstream 429 stops probing other local pipes', async () => {
  const calls = []; await assert.rejects(sendArchivedChatgptMessage(request, { discoverPipes: () => ['first', 'second'], withPipe: fakePipe({ rateLimit: true }, calls) }), /429/); assert.equal(calls.length, 1);
});
test('unarchived target never receives a message', async () => {
  const calls = []; await assert.rejects(sendArchivedChatgptMessage(request, { discoverPipes: () => ['test'], withPipe: fakePipe({ archive: false }, calls) })); assert.equal(calls.includes('send_message_to_thread'), false);
});
