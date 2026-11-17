// The forge store: repositories, their git objects and refs, issues,
// pull requests and the views the APIs render from them.
//
// One Forge holds every repository, keyed by "owner/name". A Repository
// owns its object map, its refs, and its issue/pull-request records. All
// ids are counters in creation order and all timestamps are the fixed
// epoch, so the store is fully deterministic for a given request stream.
// Node runs each request handler to completion without interleaving, so no
// lock is needed: a request either reads or mutates, never both at once.

import {
  EPOCH_ISO,
  MAIN_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
} from './consts.ts';
import {
  encodeCommit,
  encodeTree,
  hashObj,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObj,
  type GitObj,
  type ObjStore,
  type TreeEntry,
} from './gitobjs.ts';

/** An error that maps straight onto an HTTP status with a JSON message. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CommentRec {
  id: number;
  seq: number;
  gid: string;
  body: string;
}

export interface IssueRec {
  number: number;
  dbId: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  dbId: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  mergeBase: string | null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts between two blobs, from their longest common subsequence. */
export function lineCounts(oldBytes: Buffer, newBytes: Buffer): [number, number] {
  if (oldBytes.equals(newBytes)) return [0, 0];
  const oldLines = oldBytes.toString('utf8').split('\n');
  const newLines = newBytes.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return [newLines.length > 0 ? 1 : 0, oldLines.length > 0 ? 1 : 0];
  }
  const width = newLines.length + 1;
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const common = prev[newLines.length] ?? 0;
  return [newLines.length - common, oldLines.length - common];
}

// ---------------------------------------------------------------------------
// one repository

export class Repository {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch = MAIN_BRANCH;
  readonly objects: ObjStore = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextIssue = 1;
  nextComment = 1;
  nextPull = 1;
  readonly seq: number;

  constructor(id: number, name: string, owner: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.isPrivate = isPrivate;
    this.description = description;
    this.seq = id;
  }

  // -- refs and objects ---------------------------------------------------

  tipOf(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  headTip(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  /** The default branch's commit, following tags. */
  headCommit(): string | null {
    const tip = this.headTip();
    if (tip === undefined) return null;
    return peelToCommit(this.objects, tip);
  }

  /**
   * Resolve a branch name, a full ref, or a 40-hex id to a commit id.
   * Empty means the default branch. Null when nothing resolves.
   */
  resolveRef(ref?: string | null): string | null {
    if (ref === undefined || ref === null || ref === '') return this.headCommit();
    if (this.refs.has(ref)) return peelToCommit(this.objects, this.refs.get(ref) as string);
    const full = `refs/heads/${ref}`;
    if (this.refs.has(full)) return peelToCommit(this.objects, this.refs.get(full) as string);
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const entry = this.objects.get(ref);
      if (entry !== undefined && (entry.kind === 'commit' || entry.kind === 'tag')) {
        return peelToCommit(this.objects, ref);
      }
    }
    return null;
  }

  // -- trees ---------------------------------------------------------------

  treeEntries(treeOid: string | null): TreeEntry[] {
    if (treeOid === null) return [];
    const entry = this.objects.get(treeOid);
    if (entry === undefined || entry.kind !== 'tree') return [];
    return parseTree(entry.data);
  }

  /** [mode, oid] of `path` in the tree, or null. */
  lookupPath(treeOid: string | null, path: string): [string, string] | null {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      let found: [string, string] | null = null;
      for (const entry of this.treeEntries(current)) {
        if (entry.name === part) {
          found = [entry.mode, entry.oid];
          break;
        }
      }
      if (found === null) return null;
      if (i === parts.length - 1) return found;
      if (found[0] !== '40000') return null;
      current = found[1];
    }
    return null;
  }

  /** Every blob under a tree as {path: {mode, oid}}, recursively. */
  flattenTree(treeOid: string | null, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    for (const entry of this.treeEntries(treeOid)) {
      const path = prefix + entry.name;
      if (entry.mode === '40000') {
        for (const [sub, value] of this.flattenTree(entry.oid, `${path}/`)) out.set(sub, value);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /**
   * A new tree id equal to `baseTree` with `path` set to `blobOid`
   * (or removed when null). Missing intermediate directories are built;
   * an empty result is null.
   */
  setPath(baseTree: string | null, parts: readonly string[], blobOid: string | null): string | null {
    const entries = this.treeEntries(baseTree);
    const name = parts[0] as string;
    if (parts.length === 1) {
      const kept = entries.filter((e) => e.name !== name);
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      if (kept.length === 0) return null;
      return putObj(this.objects, 'tree', encodeTree(kept));
    }
    const rest = entries.filter((e) => e.name !== name);
    let child: string | null = null;
    for (const entry of entries) {
      if (entry.name === name && entry.mode === '40000') child = entry.oid;
    }
    const grown = this.setPath(child, parts.slice(1), blobOid);
    if (grown === null) {
      if (rest.length === 0) return null;
      return putObj(this.objects, 'tree', encodeTree(rest));
    }
    return putObj(this.objects, 'tree', encodeTree([...rest, { mode: '40000', name, oid: grown }]));
  }

  /** Build a tree id from a flat {path: {mode, oid}} map. */
  treeFromFlat(flat: Map<string, { mode: string; oid: string }>): string | null {
    type Node = Map<string, Node | { mode: string; oid: string }>;
    const root: Node = new Map();
    for (const [path, value] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let next = node.get(part);
        if (next === undefined || !(next instanceof Map)) {
          next = new Map();
          node.set(part, next);
        }
        node = next;
      }
      node.set(parts[parts.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) entries.push({ mode: '40000', name, oid: build(value) });
        else entries.push({ mode: value.mode, name, oid: value.oid });
      }
      return putObj(this.objects, 'tree', encodeTree(entries));
    };
    if (root.size === 0) return putObj(this.objects, 'tree', encodeTree([]));
    return build(root);
  }

  commitTree(commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const entry = this.objects.get(commitOid);
    if (entry === undefined || entry.kind !== 'commit') return null;
    return parseCommit(entry.data).tree;
  }

  /** The bytes of `path` at `commitOid`, or null. */
  fileBytes(commitOid: string | null, path: string): Buffer | null {
    const tree = this.commitTree(commitOid);
    if (tree === null) return null;
    const found = this.lookupPath(tree, path);
    if (found === null || found[0] === '40000') return null;
    const entry = this.objects.get(found[1]);
    return entry === undefined ? null : entry.data;
  }

  // -- commits -------------------------------------------------------------

  newCommit(treeOid: string, parents: readonly string[], message: string): string {
    return putObj(this.objects, 'commit', encodeCommit({ tree: treeOid, parents, message }));
  }

  /**
   * Commit `content` at `path` on `branch`, creating the branch from the
   * default tip when it is missing and the repository's first commit when
   * there are no refs at all. Returns the commit and blob ids and whether
   * the file is new on that branch.
   */
  commitFile(branch: string, path: string, content: Buffer, message: string): { commitOid: string; blobOid: string; isNew: boolean } {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    let parents: string[];
    let baseTree: string | null;
    if (tip === undefined) {
      const parent = this.headCommit();
      parents = parent === null ? [] : [parent];
      baseTree = parent === null ? null : this.commitTree(parent);
    } else {
      const parent = peelToCommit(this.objects, tip);
      parents = parent === null ? [] : [parent];
      baseTree = parent === null ? null : this.commitTree(parent);
    }
    const isNew = baseTree === null ? true : this.lookupPath(baseTree, path) === null;
    const blobOid = putObj(this.objects, 'blob', content);
    const parts = path.split('/').filter((p) => p !== '');
    const newTree = this.setPath(baseTree, parts, blobOid);
    const commitOid = this.newCommit(newTree ?? putObj(this.objects, 'tree', encodeTree([])), parents, message);
    this.refs.set(ref, commitOid);
    return { commitOid, blobOid, isNew };
  }

  /** Commit the removal of `path` on `branch`. Throws ApiError 404. */
  deleteFile(branch: string, path: string, message: string): string {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    if (tip === undefined) throw new ApiError(404, 'branch not found');
    const parent = peelToCommit(this.objects, tip);
    if (parent === null) throw new ApiError(404, 'branch not found');
    const baseTree = this.commitTree(parent);
    if (this.lookupPath(baseTree, path) === null) throw new ApiError(404, 'file not found');
    const parts = path.split('/').filter((p) => p !== '');
    const newTree = this.setPath(baseTree, parts, null);
    const commitOid = this.newCommit(newTree ?? putObj(this.objects, 'tree', encodeTree([])), [parent], message);
    this.refs.set(ref, commitOid);
    return commitOid;
  }

  /** Commit ids reachable from `tip`, newest first (first-parent DFS). */
  commitsFrom(tip: string | null): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = tip === null ? [] : [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const entry = this.objects.get(oid);
      if (entry === undefined || entry.kind !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(entry.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** The first common ancestor of `a` and `b`, or null. */
  mergeBase(a: string | null, b: string | null): string | null {
    if (a === null || b === null) return null;
    const ancestors = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestors.has(oid)) continue;
      const entry = this.objects.get(oid);
      if (entry === undefined || entry.kind !== 'commit') continue;
      ancestors.add(oid);
      for (const parent of parseCommit(entry.data).parents) stackA.push(parent);
    }
    const seen = new Set<string>();
    const stackB: string[] = [b];
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const entry = this.objects.get(oid);
      if (entry === undefined || entry.kind !== 'commit') continue;
      for (const parent of parseCommit(entry.data).parents) stackB.push(parent);
    }
    return null;
  }

  /** Per-file changes from `baseTree` to `headTree`. */
  diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const files: FileChange[] = [];
    const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
    for (const path of paths) {
      const inBase = base.get(path);
      const inHead = head.get(path);
      const oldBytes = inBase === undefined ? Buffer.alloc(0) : (this.objects.get(inBase.oid)?.data ?? Buffer.alloc(0));
      const newBytes = inHead === undefined ? Buffer.alloc(0) : (this.objects.get(inHead.oid)?.data ?? Buffer.alloc(0));
      if (inBase !== undefined && inHead === undefined) {
        const [, deletions] = lineCounts(oldBytes, Buffer.alloc(0));
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (inHead !== undefined && inBase === undefined) {
        const [additions] = lineCounts(Buffer.alloc(0), newBytes);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
        const [additions, deletions] = lineCounts(oldBytes, newBytes);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * Three-way merge of `headCommit` into `tipCommit` over `baseCommit`:
   * the merged tree id, or null plus conflict=true when both sides
   * changed the same path differently.
   */
  threeWay(baseCommit: string | null, headCommit: string | null, tipCommit: string | null): { tree: string | null; conflict: boolean } {
    const base = this.flattenTree(baseCommit === null ? null : this.commitTree(baseCommit));
    const head = this.flattenTree(headCommit === null ? null : this.commitTree(headCommit));
    const tip = this.flattenTree(tipCommit === null ? null : this.commitTree(tipCommit));
    const merged = new Map(tip);
    let conflict = false;
    const paths = [...new Set([...base.keys(), ...head.keys(), ...tip.keys()])].sort();
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      const bOid = b?.oid ?? null;
      const hOid = h?.oid ?? null;
      const tOid = t?.oid ?? null;
      if (hOid === tOid) continue;
      if (tOid === bOid) {
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
      } else if (hOid === bOid) {
        continue;
      } else {
        conflict = true;
      }
    }
    if (conflict) return { tree: null, conflict: true };
    return { tree: this.treeFromFlat(merged), conflict: false };
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
  mergeableOf(pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = this.branchTip(pull.head);
    const baseTip = this.branchTip(pull.base);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const headCommit = peelToCommit(this.objects, headTip);
    const baseCommit = peelToCommit(this.objects, baseTip);
    if (headCommit === null || baseCommit === null) return 'UNKNOWN';
    if (headCommit === baseCommit) return 'UNKNOWN';
    const base = this.mergeBase(baseCommit, headCommit);
    const { conflict } = this.threeWay(base, headCommit, baseCommit);
    return conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  // -- views ---------------------------------------------------------------

  repoView(): Record<string, unknown> {
    return {
      id: this.id,
      node_id: globalId('Repository', this.id),
      name: this.name,
      full_name: `${this.owner}/${this.name}`,
      owner: { login: this.owner, id: VIEWER_ID, type: 'User' },
      private: this.isPrivate,
      description: this.description,
      default_branch: this.defaultBranch,
      fork: false,
      has_issues: true,
      created_at: EPOCH_ISO,
      updated_at: EPOCH_ISO,
      html_url: `https://example.invalid/${this.owner}/${this.name}`,
      url: `/api/v3/repos/${this.owner}/${this.name}`,
    };
  }

  issueView(issue: IssueRec): Record<string, unknown> {
    return {
      id: issue.dbId,
      node_id: issue.gid,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: this.labels.get(name)?.color ?? 'ededed' })),
      user: { login: this.owner, id: VIEWER_ID, type: 'User' },
      created_at: EPOCH_ISO,
      updated_at: EPOCH_ISO,
      html_url: `https://example.invalid/${this.owner}/${this.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${this.owner}/${this.name}/issues/${issue.number}`,
    };
  }

  pullView(pull: PullRec): Record<string, unknown> {
    const headSha = this.branchTip(pull.head) ?? '';
    const baseSha = this.branchTip(pull.base) ?? '';
    return {
      id: pull.dbId,
      node_id: pull.gid,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeSha,
      head: { ref: pull.head, sha: headSha, label: `${this.owner}:${pull.head}` },
      base: { ref: pull.base, sha: baseSha, label: `${this.owner}:${pull.base}` },
      user: { login: this.owner, id: VIEWER_ID, type: 'User' },
      created_at: EPOCH_ISO,
      updated_at: EPOCH_ISO,
      html_url: `https://example.invalid/${this.owner}/${this.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${this.owner}/${this.name}/pulls/${pull.number}`,
    };
  }

  /** The changed files of a pull request, base (at creation) vs head now. */
  pullFiles(pull: PullRec): FileChange[] {
    const headTip = this.branchTip(pull.head);
    const headCommit = headTip === undefined ? null : peelToCommit(this.objects, headTip);
    const baseTree = pull.mergeBase === null ? null : this.commitTree(pull.mergeBase);
    const headTree = headCommit === null ? null : this.commitTree(headCommit);
    return this.diffTrees(baseTree, headTree);
  }
}

// ---------------------------------------------------------------------------
// the forge: every repository, plus the issue/pull-request operations

export class Forge {
  readonly repos = new Map<string, Repository>();
  private nextRepoId = 1;
  private nextDbId = 1;

  /** The next shared numeric id for issues, pulls and comments. */
  dbId(): number {
    const id = this.nextDbId;
    this.nextDbId += 1;
    return id;
  }

  createRepo(name: unknown, isPrivate: unknown, description: unknown): Repository {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      throw new ApiError(422, 'Invalid repository name');
    }
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) throw new ApiError(422, 'Repository already exists');
    const repo = new Repository(this.nextRepoId, name, VIEWER_LOGIN, isPrivate === true, typeof description === 'string' ? description : '');
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository by owner/name; any other owner is simply not found. */
  lookup(owner: string, name: string): Repository | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  listRepos(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createIssue(repo: Repository, title: unknown, body: unknown, labels: unknown): IssueRec {
    if (typeof title !== 'string' || title === '') throw new ApiError(422, 'title is required');
    const wanted = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [];
    for (const label of wanted) {
      if (!repo.labels.has(label)) throw new ApiError(422, `Label '${label}' does not exist`);
    }
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: IssueRec = {
      number,
      dbId: this.dbId(),
      gid: globalId('Issue', repo.id, number),
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      labels: [...wanted],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  findIssue(repo: Repository, number: number): IssueRec | null {
    return repo.issues.get(number) ?? null;
  }

  addComment(repo: Repository, issue: IssueRec, body: unknown): CommentRec {
    const seq = repo.nextComment;
    repo.nextComment += 1;
    const comment: CommentRec = {
      id: this.dbId(),
      seq,
      gid: globalId('IssueComment', repo.id, issue.number, seq),
      body: typeof body === 'string' ? body : '',
    };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repository, title: unknown, body: unknown, head: unknown, base: unknown): PullRec {
    if (typeof head !== 'string' || repo.branchTip(head) === undefined) {
      throw new ApiError(422, `head branch '${String(head)}' does not exist`);
    }
    if (typeof base !== 'string' || repo.branchTip(base) === undefined) {
      throw new ApiError(422, `base branch '${String(base)}' does not exist`);
    }
    for (const pull of repo.pulls.values()) {
      if (pull.head === head && pull.state === 'open') {
        throw new ApiError(422, `A pull request already exists for ${head}`);
      }
    }
    const headCommit = peelToCommit(repo.objects, repo.branchTip(head) as string);
    const baseCommit = peelToCommit(repo.objects, repo.branchTip(base) as string);
    const mergeBase = headCommit === null || baseCommit === null ? null : repo.mergeBase(baseCommit, headCommit);
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pull: PullRec = {
      number,
      dbId: this.dbId(),
      gid: globalId('PullRequest', repo.id, number),
      title: typeof title === 'string' ? title : '',
      body: typeof body === 'string' ? body : '',
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      mergeBase,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  findPull(repo: Repository, number: number): PullRec | null {
    return repo.pulls.get(number) ?? null;
  }

  /**
   * Squash-merge a pull request onto its base branch. The merge commit has
   * the base tip as its only parent and the merged tree. Throws ApiError
   * 405 on a conflict or an already-closed pull, 422 on a missing branch.
   */
  mergePull(repo: Repository, pull: PullRec): { sha: string; message: string } {
    if (pull.merged) throw new ApiError(405, 'Pull request already merged');
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is closed');
    const headTip = repo.branchTip(pull.head);
    const baseTip = repo.branchTip(pull.base);
    if (headTip === undefined || baseTip === undefined) throw new ApiError(422, 'branch not found');
    const headCommit = peelToCommit(repo.objects, headTip);
    const baseCommit = peelToCommit(repo.objects, baseTip);
    if (headCommit === null || baseCommit === null) throw new ApiError(422, 'branch not found');
    const base = repo.mergeBase(baseCommit, headCommit);
    const { tree, conflict } = repo.threeWay(base, headCommit, baseCommit);
    if (conflict || tree === null) throw new ApiError(405, 'Merge conflict');
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const mergeSha = repo.newCommit(tree, [baseCommit], message);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = EPOCH_ISO;
    pull.mergeSha = mergeSha;
    return { sha: mergeSha, message };
  }
}

/** The one forge the server process serves. */
export const FORGE = new Forge();
