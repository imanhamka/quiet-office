import path from 'node:path';

// Mirrors pixel-agents' Claude provider capabilities (providers/hook/claude/claude.ts).
export const READING_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
export const SUBAGENT_TOOLS = ['Task', 'Agent'];
const SUBAGENT_TOOL_SET = new Set(SUBAGENT_TOOLS);

const AGENT_TYPE_MAX = 30;

export function isSubagentTool(name) {
  return SUBAGENT_TOOL_SET.has(name);
}

function base(p) {
  return typeof p === 'string' && p ? path.basename(p) : '';
}

function withName(verb, p) {
  const b = base(p);
  return b ? `${verb} ${b}` : verb;
}

// The webview parses the English `Subtask:` prefix for the sub-agent label.
export function subtaskStatus(agentType) {
  const t = typeof agentType === 'string' ? agentType.replace(/[^\w.:-]+/g, ' ').trim() : '';
  const cut = t.length > AGENT_TYPE_MAX ? t.slice(0, AGENT_TYPE_MAX) : t;
  return `Subtask: ${cut || 'agent'}`;
}

// Status string = verb + basename only. Never command text, file contents or prompts.
// Prefixes match webview-ui/src/office/toolUtils.ts STATUS_TO_TOOL so the
// webview picks the right animation even where it parses the status string.
export function formatToolStatus(toolName, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const name = typeof toolName === 'string' ? toolName : '';
  switch (name) {
    case 'Read':
      return withName('Reading', inp.file_path);
    case 'Edit':
    case 'MultiEdit':
      return withName('Editing', inp.file_path);
    case 'Write':
      return withName('Writing', inp.file_path);
    case 'NotebookEdit':
      return withName('Editing', inp.notebook_path);
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'Running command';
    case 'Grep':
      return 'Searching code';
    case 'Glob':
      return 'Searching files';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent':
      // Never the description or prompt: both are prompt-derived.
      return subtaskStatus(inp.subagent_type);
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'Planning';
    case 'TodoWrite':
      return 'Updating todos';
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        const tool = parts.slice(2).join('__') || parts[1] || 'tool';
        return `Using ${tool}`;
      }
      return `Using ${name || 'tool'}`;
    }
  }
}
