// GraphQL v4 at /api/graphql: a small lexer, a recursive-descent parser
// for the documents gh and github-mcp-server send, a schema validator and
// an executor over the same forge the REST surface uses.
//
// The documents the suite sends are fixed shapes (viewer, repository,
// issue/pull reads, __type probes, the five mutations, batching), so the
// parser covers the GraphQL value grammar those documents use: variables,
// enums, input objects, lists, inline fragments and operation names.

import { VIEWER_LOGIN, globalId, parseGlobalId } from './consts.ts';
import { ApiError, FORGE, type Forge, type IssueRec, type PullRec, type Repository } from './vault.ts';
import { errorReply, jsonReply, type Reply } from './web.ts';

export class GqlError extends Error {}

// ---------------------------------------------------------------------------
// lexer

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'ellipsis' | 'eof';

interface Token {
  kind: TokKind;
  value: string;
}

const TOKEN_RE = /(\s+|#[^\n]*|,\s*|\.\.\.)|([_A-Za-z][_A-Za-z0-9]*)|(-?[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?)|(-?[0-9]+)|("(?:\\.|[^"\\])*")|([!$():=@\[\]{}.|])/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    TOKEN_RE.lastIndex = pos;
    const match = TOKEN_RE.exec(text);
    if (match === null || match.index !== pos) {
      throw new GqlError(`Unexpected character ${JSON.stringify(text[pos])} in GraphQL document`);
    }
    pos = TOKEN_RE.lastIndex;
    const [, skip, name, float, int, str, punct] = match;
    if (skip !== undefined) {
      if (skip === '...') tokens.push({ kind: 'ellipsis', value: '...' });
      continue;
    }
    if (name !== undefined) tokens.push({ kind: 'name', value: name });
    else if (float !== undefined) tokens.push({ kind: 'float', value: float });
    else if (int !== undefined) tokens.push({ kind: 'int', value: int });
    else if (str !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(str);
      } catch {
        throw new GqlError('Bad string literal in GraphQL document');
      }
      tokens.push({ kind: 'string', value: String(parsed) });
    } else if (punct !== undefined) {
      if (punct === '.') throw new GqlError('Unexpected character "." in GraphQL document');
      tokens.push({ kind: 'punct', value: punct });
    }
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser: values, selections, operations

export type ValueNode =
  | { tag: 'var'; name: string }
  | { tag: 'list'; items: ValueNode[] }
  | { tag: 'object'; fields: Record<string, ValueNode> }
  | { tag: 'string'; value: string }
  | { tag: 'int'; value: number }
  | { tag: 'float'; value: number }
  | { tag: 'bool'; value: boolean }
  | { tag: 'null' }
  | { tag: 'enum'; value: string };

export interface Selection {
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

export interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, string>;
  selections: Selection[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(text: string) {
    this.tokens = tokenize(text);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    this.pos += 1;
    return tok;
  }

  private expect(value: string): void {
    const tok = this.next();
    if (tok.value !== value) throw new GqlError(`Expected ${JSON.stringify(value)}, got ${JSON.stringify(tok.value)}`);
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new GqlError(`Expected a name, got ${JSON.stringify(tok.value)}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') ops.push(this.parseOperation());
    return ops;
  }

  private parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const head = this.peek();
    if (head.kind === 'name' && (head.value === 'query' || head.value === 'mutation' || head.value === 'subscription')) {
      this.next();
      opType = head.value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (!(head.kind === 'punct' && head.value === '{')) {
      throw new GqlError(`Expected an operation, got ${JSON.stringify(head.value)}`);
    }
    let varDefs: Record<string, string> = {};
    if (this.peek().value === '(') varDefs = this.parseVarDefs();
    const selections = this.parseSelectionSet();
    return { opType, name, varDefs, selections };
  }

  private parseVarDefs(): Record<string, string> {
    this.expect('(');
    const defs: Record<string, string> = {};
    while (this.peek().value !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      defs[name] = this.parseType();
      if (this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expect(')');
    return defs;
  }

  private parseType(): string {
    const tok = this.next();
    let result: string;
    if (tok.kind === 'punct' && tok.value === '[') {
      result = `[${this.parseType()}]`;
      this.expect(']');
    } else if (tok.kind === 'name') {
      result = tok.value;
    } else {
      throw new GqlError(`Expected a type, got ${JSON.stringify(tok.value)}`);
    }
    if (this.peek().value === '!') {
      this.next();
      result += '!';
    }
    return result;
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const fields: Selection[] = [];
    while (this.peek().value !== '}') fields.push(this.parseSelection());
    this.expect('}');
    return fields;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeName = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: '', name: '', args: {}, selections, fragmentType: typeName };
      }
      throw new GqlError('Named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().value === '(') args = this.parseArgs();
    let selections: Selection[] | null = null;
    if (this.peek().value === '{') selections = this.parseSelectionSet();
    return { alias: alias ?? name, name, args, selections, fragmentType: null };
  }

  private parseArgs(): Record<string, ValueNode> {
    this.expect('(');
    const args: Record<string, ValueNode> = {};
    while (this.peek().value !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { tag: 'var', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { tag: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().value !== '}') {
        const key = this.expectName();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { tag: 'object', fields };
    }
    if (tok.kind === 'string') return { tag: 'string', value: tok.value };
    if (tok.kind === 'int') return { tag: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { tag: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { tag: 'bool', value: true };
      if (tok.value === 'false') return { tag: 'bool', value: false };
      if (tok.value === 'null') return { tag: 'null' };
      return { tag: 'enum', value: tok.value };
    }
    throw new GqlError(`Unexpected value ${JSON.stringify(tok.value)}`);
  }
}

/** Resolve a parsed value against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.tag) {
    case 'var':
      return variables[node.name];
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = resolveValue(child, variables);
      return out;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
  }
}

// ---------------------------------------------------------------------------
// schema: the fields each type holds, for validation and introspection

const SCHEMA_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  User: new Set(['login']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  PullRequestConnection: new Set(['nodes']),
  PullRequestChangedFileConnection: new Set(['nodes']),
  PullRequestChangedFile: new Set(['path']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  IssueCommentEdge: new Set(['node']),
  IssueComment: new Set(['id', 'body']),
  __Type: new Set(['name', 'fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  Node: new Set(['id']),
};

const INTROSPECTED_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'private', 'fork', 'createdAt'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
};

/** The child type a field's sub-selections belong to, or null (scalar). */
function childType(parent: string, field: string): string | null {
  const map: Record<string, string> = {
    'Query.viewer': 'User',
    'Query.repository': 'Repository',
    'Query.node': 'Node',
    'Query.__type': '__Type',
    'Repository.owner': 'User',
    'Repository.defaultBranchRef': 'Ref',
    'Repository.issue': 'Issue',
    'Repository.issues': 'IssueConnection',
    'Repository.pullRequests': 'PullRequestConnection',
    'Repository.pullRequest': 'PullRequest',
    'IssueConnection.nodes': 'Issue',
    'IssueConnection.pageInfo': 'PageInfo',
    'PullRequestConnection.nodes': 'PullRequest',
    'PullRequest.files': 'PullRequestChangedFileConnection',
    'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
    'Mutation.createIssue': 'CreateIssuePayload',
    'Mutation.closeIssue': 'CloseIssuePayload',
    'Mutation.createPullRequest': 'CreatePullRequestPayload',
    'Mutation.mergePullRequest': 'MergePullRequestPayload',
    'Mutation.addComment': 'AddCommentPayload',
    'CreateIssuePayload.issue': 'Issue',
    'CloseIssuePayload.issue': 'Issue',
    'CreatePullRequestPayload.pullRequest': 'PullRequest',
    'MergePullRequestPayload.pullRequest': 'PullRequest',
    'AddCommentPayload.commentEdge': 'IssueCommentEdge',
    'IssueCommentEdge.node': 'IssueComment',
    '__Type.fields': '__Field',
    '__Type.enumValues': '__EnumValue',
  };
  return map[`${parent}.${field}`] ?? null;
}

/** Walk a document against the schema; the first unknown field fails. */
function validate(op: Operation): void {
  const walk = (selections: Selection[], typeName: string): void => {
    const fields = SCHEMA_FIELDS[typeName];
    if (fields === undefined) return;
    for (const field of selections) {
      if (field.fragmentType !== null) {
        walk(field.selections ?? [], field.fragmentType);
        continue;
      }
      if (field.name === '__typename') continue;
      if (!fields.has(field.name)) {
        throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
      }
      const child = childType(typeName, field.name);
      if (child !== null && field.selections !== null) walk(field.selections, child);
    }
  };
  walk(op.selections, op.opType === 'mutation' ? 'Mutation' : 'Query');
}

// ---------------------------------------------------------------------------
// executor: values are tagged wrappers so nesting resolves by kind

type GqlValue =
  | { tag: 'User'; login: string }
  | { tag: 'Repository'; repo: Repository }
  | { tag: 'Ref'; name: string }
  | { tag: 'Issue'; repo: Repository; issue: IssueRec }
  | { tag: 'IssueConn'; nodes: GqlValue[]; pageInfo: GqlValue }
  | { tag: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { tag: 'Pull'; repo: Repository; pull: PullRec }
  | { tag: 'PullConn'; pulls: GqlValue[] }
  | { tag: 'FilesConn'; files: GqlValue[] }
  | { tag: 'ChangedFile'; path: string }
  | { tag: 'TypeInfo'; typeName: string }
  | { tag: 'FieldName'; name: string }
  | { tag: 'EnumName'; name: string }
  | { tag: 'CreateIssuePayload'; repo: Repository; issue: IssueRec }
  | { tag: 'CloseIssuePayload'; repo: Repository; issue: IssueRec }
  | { tag: 'CreatePullPayload'; repo: Repository; pull: PullRec }
  | { tag: 'MergePullPayload'; repo: Repository; pull: PullRec }
  | { tag: 'AddCommentPayload'; comment: { id: string; body: string } }
  | { tag: 'CommentEdge'; comment: { id: string; body: string } }
  | { tag: 'Comment'; comment: { id: string; body: string } };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
}

function fieldArgs(ctx: ExecCtx, field: Selection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) out[key] = resolveValue(node, ctx.variables);
  return out;
}

function issueConnection(repo: Repository, args: Record<string, unknown>): GqlValue {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const decoded = parseGlobalId(after);
    if (decoded !== null && decoded[0] === 'IssueCursor' && decoded[1][0] !== undefined) {
      const cursorNumber = Number.parseInt(decoded[1][0], 10);
      if (!Number.isNaN(cursorNumber)) {
        const idx = issues.findIndex((i) => i.number === cursorNumber);
        if (idx >= 0) issues = issues.slice(idx + 1);
      }
    }
  }
  let hasNext = false;
  const first = args.first;
  if (typeof first === 'number') {
    hasNext = issues.length > first;
    issues = issues.slice(0, first);
  }
  const endCursor = issues.length > 0 ? globalId('IssueCursor', (issues[issues.length - 1] as IssueRec).number) : null;
  return {
    tag: 'IssueConn',
    nodes: issues.map((issue): GqlValue => ({ tag: 'Issue', repo, issue })),
    pageInfo: { tag: 'PageInfo', hasNextPage: hasNext, endCursor },
  };
}

function findRepoById(forge: Forge, gidValue: unknown): Repository | null {
  const decoded = parseGlobalId(gidValue);
  if (decoded === null || decoded[0] !== 'Repository' || decoded[1][0] === undefined) return null;
  for (const repo of forge.listRepos()) {
    if (String(repo.id) === decoded[1][0]) return repo;
  }
  return null;
}

function findIssueById(forge: Forge, gidValue: unknown): { repo: Repository; issue: IssueRec } | null {
  const decoded = parseGlobalId(gidValue);
  if (decoded === null || decoded[0] !== 'Issue' || decoded[1].length < 2) return null;
  for (const repo of forge.listRepos()) {
    if (String(repo.id) !== decoded[1][0]) continue;
    const issue = forge.findIssue(repo, Number.parseInt(decoded[1][1] as string, 10));
    if (issue !== null) return { repo, issue };
  }
  return null;
}

function findPullById(forge: Forge, gidValue: unknown): { repo: Repository; pull: PullRec } | null {
  const decoded = parseGlobalId(gidValue);
  if (decoded === null || decoded[0] !== 'PullRequest' || decoded[1].length < 2) return null;
  for (const repo of forge.listRepos()) {
    if (String(repo.id) !== decoded[1][0]) continue;
    const pull = forge.findPull(repo, Number.parseInt(decoded[1][1] as string, 10));
    if (pull !== null) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------
// field resolution

function resolveField(ctx: ExecCtx, typeName: string, parent: GqlValue | null, field: Selection): unknown {
  const args = fieldArgs(ctx, field);
  const name = field.name;

  if (typeName === 'Query') {
    if (name === 'viewer') return { tag: 'User', login: VIEWER_LOGIN } satisfies GqlValue;
    if (name === 'repository') {
      const repo = ctx.forge.lookup(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : ({ tag: 'Repository', repo } satisfies GqlValue);
    }
    if (name === 'node') {
      const decoded = parseGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded[0] === 'Repository' && decoded[1][0] !== undefined) {
        for (const repo of ctx.forge.listRepos()) {
          if (String(repo.id) === decoded[1][0]) return { tag: 'Repository', repo } satisfies GqlValue;
        }
      }
      if (decoded[0] === 'Issue' && decoded[1].length >= 2) {
        const found = findIssueById(ctx.forge, args.id);
        if (found !== null) return { tag: 'Issue', repo: found.repo, issue: found.issue } satisfies GqlValue;
      }
      if (decoded[0] === 'PullRequest' && decoded[1].length >= 2) {
        const found = findPullById(ctx.forge, args.id);
        if (found !== null) return { tag: 'Pull', repo: found.repo, pull: found.pull } satisfies GqlValue;
      }
      return null;
    }
    if (name === '__type') return { tag: 'TypeInfo', typeName: String(args.name ?? '') } satisfies GqlValue;
    throw new GqlError(`Cannot query field "${name}" on type "Query".`);
  }

  if (typeName === 'User') {
    const user = parent as { tag: 'User'; login: string };
    return name === 'login' ? user.login : null;
  }

  if (typeName === 'Repository') {
    const { repo } = parent as { tag: 'Repository'; repo: Repository };
    switch (name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { tag: 'User', login: repo.owner } satisfies GqlValue;
      case 'defaultBranchRef': {
        const tip = repo.headTip();
        if (tip === undefined) return null;
        return { tag: 'Ref', name: repo.defaultBranch } satisfies GqlValue;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = ctx.forge.findIssue(repo, Number(args.number));
        return issue === null ? null : ({ tag: 'Issue', repo, issue } satisfies GqlValue);
      }
      case 'issues':
        return issueConnection(repo, args);
      case 'pullRequests': {
        let pulls = [...repo.pulls.values()];
        if (typeof args.first === 'number') pulls = pulls.slice(0, args.first);
        return {
          tag: 'PullConn',
          pulls: pulls.map((pull): GqlValue => ({ tag: 'Pull', repo, pull })),
        } satisfies GqlValue;
      }
      case 'pullRequest': {
        const pull = ctx.forge.findPull(repo, Number(args.number));
        return pull === null ? null : ({ tag: 'Pull', repo, pull } satisfies GqlValue);
      }
      default:
        return null;
    }
  }

  if (typeName === 'Ref') return (parent as { tag: 'Ref'; name: string }).name;

  if (typeName === 'Issue') {
    const { issue } = parent as { tag: 'Issue'; repo: Repository; issue: IssueRec };
    switch (name) {
      case 'id':
        return issue.gid;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state.toUpperCase();
      case 'body':
        return issue.body;
      default:
        return null;
    }
  }

  if (typeName === 'IssueConnection') {
    const conn = parent as { tag: 'IssueConn'; nodes: GqlValue[]; pageInfo: GqlValue };
    return name === 'nodes' ? conn.nodes : conn.pageInfo;
  }

  if (typeName === 'PageInfo') {
    const info = parent as { tag: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };
    return name === 'hasNextPage' ? info.hasNextPage : info.endCursor;
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = parent as { tag: 'Pull'; repo: Repository; pull: PullRec };
    switch (name) {
      case 'id':
        return pull.gid;
      case 'number':
        return pull.number;
      case 'state':
        return pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable':
        return repo.mergeableOf(pull);
      case 'files': {
        let files = repo.pullFiles(pull);
        if (typeof args.first === 'number') files = files.slice(0, args.first);
        return {
          tag: 'FilesConn',
          files: files.map((f): GqlValue => ({ tag: 'ChangedFile', path: f.filename })),
        } satisfies GqlValue;
      }
      default:
        return null;
    }
  }

  if (typeName === 'PullRequestConnection') return (parent as { tag: 'PullConn'; pulls: GqlValue[] }).pulls;
  if (typeName === 'PullRequestChangedFileConnection') return (parent as { tag: 'FilesConn'; files: GqlValue[] }).files;
  if (typeName === 'PullRequestChangedFile') return (parent as { tag: 'ChangedFile'; path: string }).path;

  if (typeName === 'Mutation') return runMutation(ctx, name, args);

  if (typeName === '__Type') {
    const info = parent as { tag: 'TypeInfo'; typeName: string };
    if (name === 'name') return info.typeName;
    if (name === 'fields') {
      const fields = INTROSPECTED_FIELDS[info.typeName];
      if (fields === undefined) return [];
      return fields.map((f): GqlValue => ({ tag: 'FieldName', name: f }));
    }
    if (name === 'enumValues') {
      const values = ENUM_VALUES[info.typeName];
      if (values === undefined) return [];
      return values.map((v): GqlValue => ({ tag: 'EnumName', name: v }));
    }
    return null;
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    return (parent as { tag: 'FieldName'; name: string }).name;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const payload = parent as { tag: 'CreateIssuePayload'; repo: Repository; issue: IssueRec };
    return { tag: 'Issue', repo: payload.repo, issue: payload.issue } satisfies GqlValue;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const payload = parent as { tag: 'CreatePullPayload'; repo: Repository; pull: PullRec };
    return { tag: 'Pull', repo: payload.repo, pull: payload.pull } satisfies GqlValue;
  }
  if (typeName === 'AddCommentPayload') {
    const payload = parent as { tag: 'AddCommentPayload'; comment: { id: string; body: string } };
    return { tag: 'CommentEdge', comment: payload.comment } satisfies GqlValue;
  }
  if (typeName === 'IssueCommentEdge') {
    const edge = parent as { tag: 'CommentEdge'; comment: { id: string; body: string } };
    return { tag: 'Comment', comment: edge.comment } satisfies GqlValue;
  }
  if (typeName === 'IssueComment') {
    const comment = (parent as { tag: 'Comment'; comment: { id: string; body: string } }).comment;
    return name === 'id' ? comment.id : comment.body;
  }

  if (typeName === 'Node') {
    // A node(id:) result: resolve the field on its concrete type.
    const concrete = (parent as GqlValue | null)?.tag;
    if (concrete !== undefined && concrete !== null) {
      const concreteType =
        concrete === 'Repository' ? 'Repository' : concrete === 'Issue' ? 'Issue' : concrete === 'Pull' ? 'PullRequest' : null;
      if (concreteType !== null) return resolveField(ctx, concreteType, parent, field);
    }
    return null;
  }

  return null;
}

/** Apply a selection set to a parent value of `typeName`. */
function select(ctx: ExecCtx, typeName: string, parent: GqlValue | null, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.fragmentType !== null) {
      const parentTag = (parent as GqlValue | null)?.tag ?? null;
      const applies = field.fragmentType === typeName || typeName === 'Node' || field.fragmentType === parentTag;
      if (!applies) continue;
      Object.assign(out, select(ctx, field.fragmentType, parent, field.selections ?? []));
      continue;
    }
    const value = resolveField(ctx, typeName, parent, field);
    out[field.alias] = nest(ctx, typeName, field, value);
  }
  return out;
}

/** Resolve a field value's sub-selections against its child type. */
function nest(ctx: ExecCtx, parentType: string, field: Selection, value: unknown): unknown {
  if (field.selections === null || value === null || value === undefined) return value;
  const child = childType(parentType, field.name);
  if (child === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && 'tag' in (item as Record<string, unknown>)) {
        return select(ctx, child, item as GqlValue, field.selections as Selection[]);
      }
      return item;
    });
  }
  if (typeof value === 'object' && 'tag' in (value as Record<string, unknown>)) {
    return select(ctx, child, value as GqlValue, field.selections as Selection[]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// mutations

function runMutation(ctx: ExecCtx, name: string, args: Record<string, unknown>): GqlValue {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = findRepoById(ctx.forge, input.repositoryId);
    if (repo === null) throw new GqlError('createIssue: repository not found');
    const issue = ctx.forge.createIssue(repo, input.title, input.body, []);
    return { tag: 'CreateIssuePayload', repo, issue };
  }
  if (name === 'closeIssue') {
    const found = findIssueById(ctx.forge, input.issueId);
    if (found === null) throw new GqlError('closeIssue: issue not found');
    found.issue.state = 'closed';
    return { tag: 'CloseIssuePayload', repo: found.repo, issue: found.issue };
  }
  if (name === 'createPullRequest') {
    const repo = findRepoById(ctx.forge, input.repositoryId);
    if (repo === null) throw new GqlError('createPullRequest: repository not found');
    try {
      const pull = ctx.forge.createPull(repo, input.title, input.body, input.headRefName, input.baseRefName);
      return { tag: 'CreatePullPayload', repo, pull };
    } catch (err) {
      if (err instanceof ApiError) throw new GqlError(err.message);
      throw err;
    }
  }
  if (name === 'mergePullRequest') {
    const found = findPullById(ctx.forge, input.pullRequestId);
    if (found === null) throw new GqlError('mergePullRequest: pull request not found');
    try {
      ctx.forge.mergePull(found.repo, found.pull);
    } catch (err) {
      if (err instanceof ApiError) throw new GqlError(err.message);
      throw err;
    }
    return { tag: 'MergePullPayload', repo: found.repo, pull: found.pull };
  }
  if (name === 'addComment') {
    const found = findIssueById(ctx.forge, input.subjectId);
    if (found === null) throw new GqlError('addComment: issue not found');
    const comment = ctx.forge.addComment(found.repo, found.issue, input.body);
    return { tag: 'AddCommentPayload', comment: { id: comment.gid, body: comment.body } };
  }
  throw new GqlError(`Cannot query field "${name}" on type "Mutation".`);
}

// ---------------------------------------------------------------------------
// top level

function executeOne(op: Record<string, unknown>): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  let doc: Operation[];
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.length === 0) return { data: null, errors: [{ message: 'Empty document' }] };
  const operation = doc[0] as Operation;
  try {
    validate(operation);
    const ctx: ExecCtx = { forge: FORGE, variables };
    const data = select(ctx, operation.opType === 'mutation' ? 'Mutation' : 'Query', null, operation.selections);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) {
      const firstAlias = operation.selections.length > 0 ? (operation.selections[0] as Selection).alias : null;
      const data: Record<string, unknown> = {};
      if (firstAlias !== null) data[firstAlias] = null;
      return { data, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

/** POST /api/graphql: one operation or a batch array of operations. */
export function routeGraphQL(body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonReply(400, { errors: [{ message: 'Request body is not valid JSON' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) =>
      op !== null && typeof op === 'object' && !Array.isArray(op)
        ? executeOne(op as Record<string, unknown>)
        : { data: null, errors: [{ message: 'operation must be an object' }] },
    );
    return jsonReply(200, results);
  }
  if (parsed !== null && typeof parsed === 'object') {
    return jsonReply(200, executeOne(parsed as Record<string, unknown>));
  }
  return jsonReply(400, { errors: [{ message: 'Request body must be an object' }] });
}

/** A 400 for a GraphQL route that is not a POST (kept for the router). */
export function graphQLMethodError(): Reply {
  return errorReply(404, 'Not Found');
}
