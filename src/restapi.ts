// REST v3 under /api/v3: repositories, branches, commits, git refs,
// contents, labels, issues, comments and pull requests.
//
// Routing is by decoded path segment: routeRest takes the segments after
// /api/v3 and dispatches to one small handler per resource. Every handler
// returns a Reply; ApiError from the store maps to its HTTP status.

import { EPOCH_ISO, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, fromB64, toB64 } from './consts.ts';
import { parseCommit, peelToCommit } from './gitobjs.ts';
import { ApiError, FORGE, type Repository } from './vault.ts';
import { emptyReply, errorReply, jsonReply, paginate, parseJsonBody, type Ctx, type Reply } from './web.ts';

/** Dispatch a /api/v3 request (segments after "api/v3"). */
export function routeRest(ctx: Ctx): Reply {
  const parts = ctx.segments.slice(2);
  try {
    if (parts.length === 0) {
      if (ctx.method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      });
    }
    if (parts.length === 1 && parts[0] === 'meta') {
      if (ctx.method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, { installed_version: '2.0.0' });
    }
    if (parts.length === 1 && parts[0] === 'user') {
      if (ctx.method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    }
    if (parts.length >= 2 && parts[0] === 'user' && parts[1] === 'repos') {
      if (parts.length !== 2) return errorReply(404, 'Not Found');
      if (ctx.method === 'POST') return createRepo(ctx);
      if (ctx.method === 'GET') return listRepos(ctx);
      return errorReply(404, 'Not Found');
    }
    if (parts.length >= 3 && parts[0] === 'repos') {
      return routeRepo(ctx, parts[1] as string, parts[2] as string, parts.slice(3));
    }
    return errorReply(404, 'Not Found');
  } catch (err) {
    if (err instanceof ApiError) return errorReply(err.status, err.message);
    throw err;
  }
}

function createRepo(ctx: Ctx): Reply {
  const { value, error } = parseJsonBody(ctx);
  if (error !== null) return error;
  const body = value as Record<string, unknown>;
  const repo = FORGE.createRepo(body.name, body.private, body.description);
  return jsonReply(201, repo.repoView());
}

function listRepos(ctx: Ctx): Reply {
  const views = FORGE.listRepos().map((repo) => repo.repoView());
  const { page, link } = paginate(views, ctx.query, '/api/v3/user/repos', ctx.baseUrl);
  return jsonReply(200, page, link === null ? undefined : { Link: link });
}

function loadRepo(owner: string, name: string): Repository | null {
  return FORGE.lookup(owner, name);
}

function routeRepo(ctx: Ctx, owner: string, name: string, rest: string[]): Reply {
  const repo = loadRepo(owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  if (rest.length === 0) {
    if (ctx.method === 'GET') return jsonReply(200, repo.repoView());
    if (ctx.method === 'PATCH') {
      const { value, error } = parseJsonBody(ctx);
      if (error !== null) return error;
      const body = value as Record<string, unknown>;
      if ('description' in body) repo.description = typeof body.description === 'string' ? body.description : '';
      if ('private' in body) repo.isPrivate = body.private === true;
      return jsonReply(200, repo.repoView());
    }
    if (ctx.method === 'DELETE') {
      FORGE.repos.delete(`${owner}/${name}`);
      return emptyReply(204);
    }
    return errorReply(404, 'Not Found');
  }
  const head = rest[0] as string;
  if (head === 'branches') return routeBranches(ctx, repo, rest.slice(1));
  if (head === 'commits') return routeCommits(ctx, repo);
  if (head === 'git' && rest.length >= 2 && rest[1] === 'refs') return routeGitRefs(ctx, repo, rest.slice(2));
  if (head === 'contents') return routeContents(ctx, repo, rest.slice(1));
  if (head === 'labels') return routeLabels(ctx, repo, rest.slice(1));
  if (head === 'issues') return routeIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return routePulls(ctx, repo, rest.slice(1));
  return errorReply(404, 'Not Found');
}

function routeBranches(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (ctx.method !== 'GET') return errorReply(404, 'Not Found');
  if (rest.length === 0) {
    const out = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string } }));
    return jsonReply(200, out);
  }
  if (rest.length === 1) {
    const tip = repo.branchTip(rest[0] as string);
    if (tip === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, { name: rest[0], commit: { sha: tip } });
  }
  return errorReply(404, 'Not Found');
}

function routeCommits(ctx: Ctx, repo: Repository): Reply {
  if (ctx.method !== 'GET') return errorReply(404, 'Not Found');
  const ref = ctx.query.get('sha');
  const tip = ref === null ? repo.headCommit() : repo.resolveRef(ref);
  const commits = tip === null ? [] : repo.commitsFrom(tip);
  const views = commits.map((oid) => {
    const info = parseCommit((repo.objects.get(oid) as { data: Buffer }).data);
    return {
      sha: oid,
      commit: {
        message: info.message,
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: EPOCH_ISO },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: EPOCH_ISO },
      },
      parents: info.parents.map((p) => ({ sha: p })),
    };
  });
  const { page, link } = paginate(views, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, ctx.baseUrl);
  return jsonReply(200, page, link === null ? undefined : { Link: link });
}

function routeGitRefs(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (ctx.method === 'POST' && rest.length === 0) {
    const { value, error } = parseJsonBody(ctx);
    if (error !== null) return error;
    const body = value as Record<string, unknown>;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return errorReply(422, 'Invalid ref or sha');
    if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
    if (!repo.objects.has(sha)) return errorReply(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return jsonReply(201, { ref, object: { sha } });
  }
  if (ctx.method === 'GET') {
    if (rest.length === 0) {
      const out = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string } }));
      return jsonReply(200, out);
    }
    const ref = `refs/${rest.join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, { ref, object: { sha: oid } });
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents

function routeContents(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (rest.length === 0) return errorReply(404, 'Not Found');
  const path = rest.join('/');
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'GET') return getContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  return errorReply(404, 'Not Found');
}

function putContents(ctx: Ctx, repo: Repository, path: string): Reply {
  const { value, error } = parseJsonBody(ctx);
  if (error !== null) return error;
  const body = value as Record<string, unknown>;
  if (typeof body.content !== 'string') return errorReply(422, 'content is required');
  let content: Buffer;
  try {
    content = fromB64(body.content);
  } catch {
    return errorReply(422, 'content is not valid base64');
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.branchTip(branch);
  let created: boolean;
  if (tip !== undefined) {
    const commit = peelToCommit(repo.objects, tip);
    const current = commit === null ? null : repo.fileBytes(commit, path);
    if (sha !== undefined) {
      if (current === null) return errorReply(404, 'Not Found');
      const found = repo.lookupPath(repo.commitTree(commit), path);
      if (found === null || found[1] !== sha) return errorReply(409, 'sha does not match the current blob');
      created = false;
    } else {
      created = current === null;
    }
  } else {
    if (sha !== undefined) return errorReply(404, 'Not Found');
    created = true;
  }
  const { commitOid, blobOid } = repo.commitFile(branch, path, content, message);
  return jsonReply(created ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha: commitOid },
  });
}

function getContents(ctx: Ctx, repo: Repository, path: string): Reply {
  const ref = ctx.query.get('ref');
  const commit = repo.resolveRef(ref);
  if (commit === null) return errorReply(404, 'Not Found');
  const tree = repo.commitTree(commit);
  const found = repo.lookupPath(tree, path);
  if (found === null) return errorReply(404, 'Not Found');
  const [mode, oid] = found;
  if (mode === '40000') {
    const entries = repo.treeEntries(oid).map((entry) => {
      const item: Record<string, unknown> = {
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
      };
      if (entry.mode !== '40000') {
        const blob = repo.objects.get(entry.oid);
        item.size = blob === undefined ? 0 : blob.data.length;
      }
      return item;
    });
    return jsonReply(200, entries);
  }
  const blob = repo.objects.get(oid);
  const data = blob === undefined ? Buffer.alloc(0) : blob.data;
  return jsonReply(200, {
    type: 'file',
    encoding: 'base64',
    content: toB64(data),
    sha: oid,
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
  });
}

function deleteContents(ctx: Ctx, repo: Repository, path: string): Reply {
  const { value, error } = parseJsonBody(ctx);
  if (error !== null) return error;
  const body = value as Record<string, unknown>;
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.branchTip(branch);
  if (tip === undefined) return errorReply(404, 'Not Found');
  const commit = peelToCommit(repo.objects, tip);
  if (commit === null) return errorReply(404, 'Not Found');
  const current = repo.lookupPath(repo.commitTree(commit), path);
  if (current === null) return errorReply(404, 'Not Found');
  if (sha !== undefined && current[1] !== sha) return errorReply(409, 'sha does not match the current blob');
  const commitOid = repo.deleteFile(branch, path, message);
  return jsonReply(200, { commit: { sha: commitOid } });
}

// ---------------------------------------------------------------------------
// labels

function routeLabels(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (rest.length !== 0) return errorReply(404, 'Not Found');
  if (ctx.method === 'POST') {
    const { value, error } = parseJsonBody(ctx);
    if (error !== null) return error;
    const body = value as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return errorReply(422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, { name, color });
    return jsonReply(201, { name, color });
  }
  if (ctx.method === 'GET') return jsonReply(200, [...repo.labels.values()]);
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues

function routeIssues(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const { value, error } = parseJsonBody(ctx);
      if (error !== null) return error;
      const body = value as Record<string, unknown>;
      const issue = FORGE.createIssue(repo, body.title, body.body, body.labels);
      return jsonReply(201, repo.issueView(issue));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') issues.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      const views = issues.map((i) => repo.issueView(i));
      const { page, link } = paginate(views, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.baseUrl);
      return jsonReply(200, page, link === null ? undefined : { Link: link });
    }
    return errorReply(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
  const issue = FORGE.findIssue(repo, number);
  if (issue === null) return errorReply(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') return jsonReply(200, repo.issueView(issue));
    if (ctx.method === 'PATCH') {
      const { value, error } = parseJsonBody(ctx);
      if (error !== null) return error;
      const body = value as Record<string, unknown>;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return jsonReply(200, repo.issueView(issue));
    }
    return errorReply(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (ctx.method === 'POST') {
      const { value, error } = parseJsonBody(ctx);
      if (error !== null) return error;
      const body = value as Record<string, unknown>;
      const comment = FORGE.addComment(repo, issue, body.body);
      return jsonReply(201, {
        id: comment.id,
        node_id: comment.gid,
        body: comment.body,
        user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
        created_at: EPOCH_ISO,
        updated_at: EPOCH_ISO,
      });
    }
    if (ctx.method === 'GET') {
      const out = issue.comments.map((c) => ({
        id: c.id,
        node_id: c.gid,
        body: c.body,
        user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
        created_at: EPOCH_ISO,
        updated_at: EPOCH_ISO,
      }));
      return jsonReply(200, out);
    }
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests

function routePulls(ctx: Ctx, repo: Repository, rest: string[]): Reply {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const { value, error } = parseJsonBody(ctx);
      if (error !== null) return error;
      const body = value as Record<string, unknown>;
      const pull = FORGE.createPull(repo, body.title, body.body, body.head, body.base);
      return jsonReply(201, repo.pullView(pull));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      const views = pulls.map((p) => repo.pullView(p));
      const { page, link } = paginate(views, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.baseUrl);
      return jsonReply(200, page, link === null ? undefined : { Link: link });
    }
    return errorReply(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
  const pull = FORGE.findPull(repo, number);
  if (pull === null) return errorReply(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') return jsonReply(200, repo.pullView(pull));
    return errorReply(404, 'Not Found');
  }
  if (rest[1] === 'files' && rest.length === 2 && ctx.method === 'GET') {
    return jsonReply(200, repo.pullFiles(pull));
  }
  if (rest[1] === 'merge' && rest.length === 2 && ctx.method === 'PUT') {
    const { error } = parseJsonBody(ctx);
    if (error !== null) return error;
    const { sha, message } = FORGE.mergePull(repo, pull);
    return jsonReply(200, { sha, merged: true, message });
  }
  return errorReply(404, 'Not Found');
}
