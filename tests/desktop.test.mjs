import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePipes, sendArchivedChatgptMessage, listHiddenExecutors, verifyHiddenExecutor } from '../src/adapters/desktop-pipe.mjs';

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

function archivePipe(pages, calls) {
  return async (_path, callback) => callback(async (method, params) => {
    calls.push({ method, ...params });
    assert.equal(params.tool, 'list_archived_threads');
    assert.equal(params.arguments.source, 'chatgpt');
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(pages[params.arguments.cursor || 'first']) }] };
  });
}
test('hidden chat discovery returns metadata only and never reads or sends a conversation', async () => {
  const calls = [], threads = [{ id: 'target', kind: 'chatgpt', title: '<script>untrusted</script>', preview: 'private preview', summary: 'private summary' }, { id: 'native', kind: 'codex' }];
  const listing = await listHiddenExecutors({ callerThreadId: 'context' }, { discoverPipes: () => ['test'], withPipe: archivePipe({ first: { threads } }, calls) });
  assert.deepEqual(listing, { threads: [{ id: 'target', title: '<script>untrusted</script>', updatedAt: null }], nextCursor: null });
  assert.equal(calls.length, 1); assert.equal(calls[0].threadId, 'context'); assert.equal(calls[0].hostId, 'local');
  assert.doesNotMatch(JSON.stringify(listing), /private preview|private summary/);
});
test('hidden connection checks exact selection across archive pages and rejects a removed chat', async () => {
  const calls = [], dependencies = { discoverPipes: () => ['test'], withPipe: archivePipe({ first: { threads: [{ id: 'other', kind: 'chatgpt' }], nextCursor: 'page2' }, page2: { threads: [{ id: 'target', kind: 'chatgpt', title: '专用后台' }] } }, calls) };
  const result = await verifyHiddenExecutor({ callerThreadId: 'context', destinationThreadId: 'target' }, dependencies);
  assert.equal(result.id, 'target'); assert.equal(calls.length, 2);
  await assert.rejects(verifyHiddenExecutor({ callerThreadId: 'context', destinationThreadId: 'removed' }, dependencies), /不在隐藏归档/);
});
test('hidden discovery stops on rate limit without probing another pipe', async () => {
  const calls = [];
  await assert.rejects(listHiddenExecutors({ callerThreadId: 'context' }, { discoverPipes: () => ['first', 'second'], withPipe: fakePipe({ rateLimit: true }, calls) }), /429/);
  assert.equal(calls.length, 1);
});
test('hidden connection rejects corrupt cyclic archive pagination', async () => {
  const calls = [], dependencies = { discoverPipes: () => ['test'], withPipe: archivePipe({ first: { threads: [], nextCursor: 'page2' }, page2: { threads: [], nextCursor: 'page2' } }, calls) };
  await assert.rejects(verifyHiddenExecutor({ callerThreadId: 'context', destinationThreadId: 'absent' }, dependencies), /cursor/);
  assert.equal(calls.length, 2);
});
