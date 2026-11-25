import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatToolStatus } from '../lib/status.mjs';
import { deriveMode } from '../lib/tracker.mjs';

test('formatToolStatus keeps verb + basename only', () => {
  assert.equal(formatToolStatus('Read', { file_path: '/a/b/secret-dir/server.ts' }), 'Reading server.ts');
  assert.equal(formatToolStatus('Edit', { file_path: '/x/y.mjs', old_string: 'S', new_string: 'T' }), 'Editing y.mjs');
  assert.equal(formatToolStatus('Write', { file_path: '/x/z.md', content: 'BODY' }), 'Writing z.md');
  assert.equal(formatToolStatus('Bash', { command: 'cat /etc/passwd' }), 'Running command');
  assert.equal(formatToolStatus('Grep', { pattern: 'password' }), 'Searching code');
  assert.equal(formatToolStatus('Glob', { pattern: '**/*.env' }), 'Searching files');
  assert.equal(formatToolStatus('WebFetch', { url: 'https://x' }), 'Fetching web content');
  assert.equal(formatToolStatus('WebSearch', { query: 'q' }), 'Searching the web');
  assert.equal(formatToolStatus('mcp__context7__query-docs', {}), 'Using query-docs');
  assert.equal(formatToolStatus('SomethingNew', { a: 1 }), 'Using SomethingNew');
  assert.equal(formatToolStatus('Read', {}), 'Reading');
});

test('sub-agent status names the agent type, never description or prompt', () => {
  assert.equal(formatToolStatus('Agent', { description: 'short desc', prompt: 'P', subagent_type: 'Explore' }), 'Subtask: Explore');
  assert.equal(formatToolStatus('Task', { description: 'x'.repeat(50), prompt: 'secret' }), 'Subtask: agent');
  assert.equal(formatToolStatus('Agent', {}), 'Subtask: agent');
  assert.equal(formatToolStatus('Agent', { subagent_type: 'y'.repeat(50) }), `Subtask: ${'y'.repeat(30)}`);
  assert.equal(formatToolStatus('Agent', { subagent_type: 'a<b>\nc' }), 'Subtask: a b c');
});

test('deriveMode maps session status', () => {
  assert.equal(deriveMode({ status: 'busy' }), 'active');
  assert.equal(deriveMode({ status: 'idle' }), 'idle');
  assert.equal(deriveMode({ status: 'waiting', waitingFor: 'permission prompt' }), 'permission');
  assert.equal(deriveMode({ status: 'waiting', waitingFor: 'approve Bash: rm' }), 'permission');
  assert.equal(deriveMode({ status: 'waiting', waitingFor: 'input needed' }), 'input');
  assert.equal(deriveMode({ status: 'waiting', waitingFor: 'dialog open' }), 'input');
  assert.equal(deriveMode({}), 'idle');
});
