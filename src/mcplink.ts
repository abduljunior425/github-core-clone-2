// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP.
//
// Two eras are served from the same dispatcher: the modern 2026-07-28
// `server/discover` flow (no handshake, no session) and the legacy
// `initialize` + `notifications/initialized` handshake. tools/list offers
// the six tools github-mcp-server documents, always the same array, and
// tools/call acts on the same forge the REST surface reads, so an object
// made over MCP reads back over REST with the same ids.

import { FORGE_VERSION, SERVER_LABEL } from './consts.ts';
import { ApiError, FORGE, type Repository } from './vault.ts';
import { emptyReply, jsonReply, type Reply } from './web.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in a fixed order: two tools/list calls serialize identically. */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const SERVER_INFO = { name: SERVER_LABEL, version: FORGE_VERSION };

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** owner/repo from tool arguments, accepting a full_name fallback. */
function repoFromArgs(args: Record<string, unknown>): Repository | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const bits = (args.full_name as string).split('/');
    if (bits.length === 2) {
      owner = bits[0] as string;
      repo = bits[1] as string;
    }
  }
  if (owner === '' || repo === '') return null;
  return FORGE.lookup(owner, repo);
}

function findTool(name: unknown): ToolDef | null {
  if (typeof name !== 'string') return null;
  const exact = MCP_TOOLS.find((t) => t.name === name);
  if (exact !== undefined) return exact;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tool of MCP_TOOLS) {
    const wanted = tool.name.replace(/[^a-z0-9]/g, '');
    if (normalized.endsWith(wanted)) return tool;
  }
  return null;
}

function callTool(params: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const name = params.name;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = findTool(name);
  if (tool === null) return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return { error: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repo = FORGE.createRepo(args.name, args.private, args.description);
        return { result: toolResult(repo.repoView()) };
      }
      case 'get_repo': {
        const repo = repoFromArgs(args);
        if (repo === null) return { result: errorResult('Repository not found') };
        return { result: toolResult(repo.repoView()) };
      }
      case 'create_issue': {
        const repo = repoFromArgs(args);
        if (repo === null) return { result: errorResult('Repository not found') };
        const issue = FORGE.createIssue(repo, args.title, args.body, []);
        return { result: toolResult(repo.issueView(issue)) };
      }
      case 'list_issues': {
        const repo = repoFromArgs(args);
        if (repo === null) return { result: errorResult('Repository not found') };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
        return { result: toolResult({ issues: issues.map((i) => repo.issueView(i)) }) };
      }
      case 'create_pull_request': {
        const repo = repoFromArgs(args);
        if (repo === null) return { result: errorResult('Repository not found') };
        const pull = FORGE.createPull(repo, args.title, args.body, args.head, args.base);
        return { result: toolResult(repo.pullView(pull)) };
      }
      case 'merge_pull_request': {
        const repo = repoFromArgs(args);
        if (repo === null) return { result: errorResult('Repository not found') };
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
        if (!Number.isInteger(number)) return { result: errorResult('pull_number must be an integer') };
        const pull = FORGE.findPull(repo, number);
        if (pull === null) return { result: errorResult('Pull request not found') };
        const { sha } = FORGE.mergePull(repo, pull);
        const view = repo.pullView(pull) as Record<string, unknown>;
        view.sha = sha;
        return { result: toolResult(view) };
      }
      default:
        return { error: { code: -32602, message: `Unknown tool: ${tool.name}` } };
    }
  } catch (err) {
    if (err instanceof ApiError) return { result: errorResult(err.message) };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// dispatcher

/** POST /mcp: one JSON-RPC request per body. */
export function routeMcp(body: Buffer): Reply {
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return jsonReply(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = request as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const id = req.id;
  if (id === undefined || id === null) {
    // A notification (notifications/initialized and friends): 202, no body.
    return emptyReply(202);
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28'],
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const outcome = callTool(params);
    if ('error' in outcome) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
