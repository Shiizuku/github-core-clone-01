// GraphQL v4: a small executor for the documents gh and github-mcp-server send, over the same
// store as REST. Supports operations with variables, aliases, arguments (objects, enums, lists),
// inline and named fragments, connections with cursors, the mutations the suite drives, Relay
// node(id), and introspection for the types the suite probes.

import { tick, VIEWER, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';
import { computeMergeable, diffCounts, performMerge, pullTrees } from './rest.ts';
import type { RestResult } from './rest.ts';

// -------------------------------------------------------------------------------------------
// Node ids

export function nodeId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeNodeId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

const repoNodeId = (repo: Repo): string => nodeId('Repository', repo.id);
const issueNodeId = (repo: Repo, issue: IssueRec): string => nodeId('Issue', repo.id, issue.number);
const pullNodeId = (repo: Repo, pull: PullRec): string => nodeId('PullRequest', repo.id, pull.number);
const commentNodeId = (id: number): string => nodeId('IssueComment', id);
const userNodeId = (): string => nodeId('User', VIEWER.id);

// -------------------------------------------------------------------------------------------
// Lexer and parser

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j++;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

interface ValueNode {
  kind: 'string' | 'number' | 'boolean' | 'null' | 'enum' | 'list' | 'object' | 'variable';
  value: unknown;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
      } else {
        let name = this.next().value;
        let alias: string | undefined;
        if (this.peek().value === ':') {
          this.next();
          alias = name;
          name = this.next().value;
        }
        const args = this.peek().value === '(' ? this.parseArguments() : new Map<string, ValueNode>();
        this.skipDirectives();
        const selectionSet = this.peek().value === '{' ? this.parseSelectionSet() : undefined;
        selections.push({ kind: 'field', alias, name, args, selectionSet });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') {
      const name = this.next().value;
      return { kind: 'variable', value: name };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.value as string];
    case 'list':
      return (node.value as ValueNode[]).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.value as Map<string, ValueNode>) out[key] = resolveValue(value, variables);
      return out;
    }
    default:
      return node.value;
  }
}

// -------------------------------------------------------------------------------------------
// Schema (for introspection and field validation)

interface FieldDef {
  name: string;
  type: string;
}

const OBJECT_FIELDS: Record<string, FieldDef[]> = {
  Query: [
    { name: 'viewer', type: 'User' },
    { name: 'repository', type: 'Repository' },
    { name: 'node', type: 'Node' },
    { name: 'nodes', type: '[Node]' },
    { name: 'search', type: 'SearchResultItemConnection' },
    { name: 'rateLimit', type: 'RateLimit' },
    { name: 'meta', type: 'GitHubMetadata' },
  ],
  Mutation: [
    { name: 'createIssue', type: 'CreateIssuePayload' },
    { name: 'closeIssue', type: 'CloseIssuePayload' },
    { name: 'reopenIssue', type: 'ReopenIssuePayload' },
    { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
    { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
    { name: 'addComment', type: 'AddCommentPayload' },
  ],
  User: [
    { name: 'id', type: 'ID' },
    { name: 'login', type: 'String' },
    { name: 'name', type: 'String' },
    { name: 'email', type: 'String' },
    { name: 'url', type: 'URI' },
    { name: 'avatarUrl', type: 'URI' },
    { name: 'isViewer', type: 'Boolean' },
    { name: 'databaseId', type: 'Int' },
  ],
  Repository: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'name', type: 'String' },
    { name: 'nameWithOwner', type: 'String' },
    { name: 'owner', type: 'RepositoryOwner' },
    { name: 'description', type: 'String' },
    { name: 'isPrivate', type: 'Boolean' },
    { name: 'isFork', type: 'Boolean' },
    { name: 'url', type: 'URI' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'pushedAt', type: 'DateTime' },
    { name: 'defaultBranchRef', type: 'Ref' },
    { name: 'viewerPermission', type: 'RepositoryPermission' },
    { name: 'hasIssuesEnabled', type: 'Boolean' },
    { name: 'hasProjectsEnabled', type: 'Boolean' },
    { name: 'hasWikiEnabled', type: 'Boolean' },
    { name: 'issue', type: 'Issue' },
    { name: 'issues', type: 'IssueConnection' },
    { name: 'pullRequest', type: 'PullRequest' },
    { name: 'pullRequests', type: 'PullRequestConnection' },
    { name: 'labels', type: 'LabelConnection' },
    { name: 'stargazerCount', type: 'Int' },
    { name: 'forkCount', type: 'Int' },
    { name: 'primaryLanguage', type: 'Language' },
  ],
  Ref: [
    { name: 'name', type: 'String' },
    { name: 'prefix', type: 'String' },
    { name: 'target', type: 'GitObject' },
  ],
  Commit: [
    { name: 'id', type: 'ID' },
    { name: 'oid', type: 'GitObjectID' },
    { name: 'message', type: 'String' },
    { name: 'committedDate', type: 'DateTime' },
  ],
  Issue: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'IssueState' },
    { name: 'author', type: 'Actor' },
    { name: 'labels', type: 'LabelConnection' },
    { name: 'comments', type: 'IssueCommentConnection' },
    { name: 'repository', type: 'Repository' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'closedAt', type: 'DateTime' },
    { name: 'url', type: 'URI' },
    { name: 'viewerCanUpdate', type: 'Boolean' },
  ],
  PullRequest: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'PullRequestState' },
    { name: 'merged', type: 'Boolean' },
    { name: 'mergedAt', type: 'DateTime' },
    { name: 'mergeCommit', type: 'Commit' },
    { name: 'headRefName', type: 'String' },
    { name: 'baseRefName', type: 'String' },
    { name: 'headRefOid', type: 'GitObjectID' },
    { name: 'baseRefOid', type: 'GitObjectID' },
    { name: 'mergeable', type: 'MergeableState' },
    { name: 'files', type: 'PullRequestChangedFileConnection' },
    { name: 'author', type: 'Actor' },
    { name: 'repository', type: 'Repository' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'closedAt', type: 'DateTime' },
    { name: 'url', type: 'URI' },
    { name: 'additions', type: 'Int' },
    { name: 'deletions', type: 'Int' },
    { name: 'changedFiles', type: 'Int' },
  ],
  IssueComment: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'body', type: 'String' },
    { name: 'author', type: 'Actor' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'url', type: 'URI' },
  ],
  Label: [
    { name: 'id', type: 'ID' },
    { name: 'name', type: 'String' },
    { name: 'color', type: 'String' },
    { name: 'description', type: 'String' },
  ],
  PullRequestChangedFile: [
    { name: 'path', type: 'String' },
    { name: 'additions', type: 'Int' },
    { name: 'deletions', type: 'Int' },
    { name: 'changeType', type: 'PatchStatus' },
  ],
  CreateIssuePayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'issue', type: 'Issue' },
  ],
  CloseIssuePayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'issue', type: 'Issue' },
  ],
  ReopenIssuePayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'issue', type: 'Issue' },
  ],
  CreatePullRequestPayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'pullRequest', type: 'PullRequest' },
  ],
  MergePullRequestPayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'pullRequest', type: 'PullRequest' },
  ],
  AddCommentPayload: [
    { name: 'clientMutationId', type: 'String' },
    { name: 'commentEdge', type: 'IssueCommentEdge' },
    { name: 'subject', type: 'Node' },
  ],
  IssueCommentEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'IssueComment' },
  ],
  RateLimit: [
    { name: 'limit', type: 'Int' },
    { name: 'cost', type: 'Int' },
    { name: 'remaining', type: 'Int' },
    { name: 'resetAt', type: 'DateTime' },
    { name: 'nodeCount', type: 'Int' },
    { name: 'used', type: 'Int' },
  ],
  PageInfo: [
    { name: 'hasNextPage', type: 'Boolean' },
    { name: 'hasPreviousPage', type: 'Boolean' },
    { name: 'startCursor', type: 'String' },
    { name: 'endCursor', type: 'String' },
  ],
  IssueConnection: [
    { name: 'nodes', type: '[Issue]' },
    { name: 'edges', type: '[IssueEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  IssueEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'Issue' },
  ],
  PullRequestConnection: [
    { name: 'nodes', type: '[PullRequest]' },
    { name: 'edges', type: '[PullRequestEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  PullRequestEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'PullRequest' },
  ],
  PullRequestChangedFileConnection: [
    { name: 'nodes', type: '[PullRequestChangedFile]' },
    { name: 'edges', type: '[PullRequestChangedFileEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  PullRequestChangedFileEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'PullRequestChangedFile' },
  ],
  LabelConnection: [
    { name: 'nodes', type: '[Label]' },
    { name: 'edges', type: '[LabelEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  LabelEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'Label' },
  ],
  IssueCommentConnection: [
    { name: 'nodes', type: '[IssueComment]' },
    { name: 'edges', type: '[IssueCommentEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  SearchResultItemConnection: [
    { name: 'nodes', type: '[SearchResultItem]' },
    { name: 'edges', type: '[SearchResultItemEdge]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'issueCount', type: 'Int' },
    { name: 'repositoryCount', type: 'Int' },
    { name: 'userCount', type: 'Int' },
  ],
  SearchResultItemEdge: [
    { name: 'cursor', type: 'String' },
    { name: 'node', type: 'SearchResultItem' },
  ],
  __Type: [
    { name: 'name', type: 'String' },
    { name: 'kind', type: '__TypeKind' },
    { name: 'description', type: 'String' },
    { name: 'fields', type: '[__Field]' },
    { name: 'enumValues', type: '[__EnumValue]' },
    { name: 'possibleTypes', type: '[__Type]' },
    { name: 'inputFields', type: '[__InputValue]' },
    { name: 'ofType', type: '__Type' },
    { name: 'specifiedByURL', type: 'String' },
    { name: 'interfaces', type: '[__Type]' },
  ],
  __Field: [
    { name: 'name', type: 'String' },
    { name: 'description', type: 'String' },
    { name: 'args', type: '[__InputValue]' },
    { name: 'type', type: '__Type' },
    { name: 'isDeprecated', type: 'Boolean' },
    { name: 'deprecationReason', type: 'String' },
  ],
  __EnumValue: [
    { name: 'name', type: 'String' },
    { name: 'description', type: 'String' },
    { name: 'isDeprecated', type: 'Boolean' },
    { name: 'deprecationReason', type: 'String' },
  ],
  __InputValue: [
    { name: 'name', type: 'String' },
    { name: 'description', type: 'String' },
    { name: 'type', type: '__Type' },
    { name: 'defaultValue', type: 'String' },
  ],
  __Schema: [
    { name: 'types', type: '[__Type]' },
    { name: 'queryType', type: '__Type' },
    { name: 'mutationType', type: '__Type' },
    { name: 'subscriptionType', type: '__Type' },
    { name: 'directives', type: '[__Directive]' },
  ],
  __Directive: [
    { name: 'name', type: 'String' },
    { name: 'description', type: 'String' },
    { name: 'locations', type: '[__DirectiveLocation]' },
    { name: 'args', type: '[__InputValue]' },
  ],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PatchStatus: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'Base64String']);

function typeKind(name: string): string {
  if (ENUM_VALUES[name]) return 'ENUM';
  if (SCALARS.has(name)) return 'SCALAR';
  return 'OBJECT';
}

// -------------------------------------------------------------------------------------------
// Execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string; path?: string[] }[];
}

/** Runtime values are tagged wrappers so the executor knows their GraphQL type. */
interface GqlObject {
  __type: string;
  value: unknown;
}

const wrap = (type: string, value: unknown): GqlObject => ({ __type: type, value });

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) + 1 : 0;
  } catch {
    return 0;
  }
}

interface Connection<T> {
  items: T[];
  total: number;
}

function paginate<T>(items: T[], args: Map<string, unknown>): Connection<T> & { startIndex: number } {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const start = indexOfCursor(args.get('after') as string | undefined);
  return { items: items.slice(start, start + first), total: items.length, startIndex: start };
}

function findRepoByNodeId(store: Store, id: string): Repo | undefined {
  const parts = decodeNodeId(id);
  if (parts[0] !== 'Repository') return undefined;
  const repoId = Number(parts[1]);
  return [...store.repos.values()].find((repo) => repo.id === repoId);
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: IssueRec } | undefined {
  const parts = decodeNodeId(id);
  if (parts[0] !== 'Issue' && parts[0] !== 'PullRequest') return undefined;
  const repoId = Number(parts[1]);
  const number = Number(parts[2]);
  const repo = [...store.repos.values()].find((r) => r.id === repoId);
  const issue = repo?.issues.get(number);
  return repo && issue ? { repo, issue } : undefined;
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: PullRec } | undefined {
  const parts = decodeNodeId(id);
  if (parts[0] !== 'PullRequest') return undefined;
  const repo = [...store.repos.values()].find((r) => r.id === Number(parts[1]));
  const pull = repo?.pulls.get(Number(parts[2]));
  return repo && pull ? { repo, pull } : undefined;
}

function pullFiles(store: Store, repo: Repo, pull: PullRec): { path: string; additions: number; deletions: number; changeType: string }[] {
  const trees = pullTrees(store, repo, pull);
  if (!trees) return [];
  const out: { path: string; additions: number; deletions: number; changeType: string }[] = [];
  const paths = new Set([...trees.base.keys(), ...trees.theirs.keys()]);
  for (const path of [...paths].sort()) {
    const before = trees.base.get(path);
    const after = trees.theirs.get(path);
    if (before?.sha === after?.sha) continue;
    const oldText = before ? (store.readObject(before.sha)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (store.readObject(after.sha)?.data.toString('utf8') ?? '') : '';
    const counts = diffCounts(oldText, newText);
    out.push({
      path,
      additions: counts.additions,
      deletions: counts.deletions,
      changeType: !before ? 'ADDED' : !after ? 'DELETED' : 'MODIFIED',
    });
  }
  return out;
}

type Resolver = (ctx: Ctx, source: GqlObject | null, args: Map<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap('User', VIEWER),
    repository: (ctx, _s, args) => {
      const owner = args.get('owner') as string;
      const name = args.get('name') as string;
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? wrap('Repository', repo) : null;
    },
    node: (ctx, _s, args) => {
      const id = args.get('id') as string;
      const parts = decodeNodeId(id);
      if (parts[0] === 'Repository') {
        const repo = findRepoByNodeId(ctx.store, id);
        return repo ? wrap('Repository', repo) : null;
      }
      if (parts[0] === 'Issue') {
        const found = findIssueByNodeId(ctx.store, id);
        return found ? wrap('Issue', { repo: found.repo, issue: found.issue }) : null;
      }
      if (parts[0] === 'PullRequest') {
        const found = findPullByNodeId(ctx.store, id);
        return found ? wrap('PullRequest', { repo: found.repo, pull: found.pull }) : null;
      }
      if (parts[0] === 'User') return wrap('User', VIEWER);
      return null;
    },
    rateLimit: () => wrap('RateLimit', {}),
    search: (_ctx, _s, args) => {
      void args;
      return wrap('SearchResultItemConnection', { items: [] as GqlObject[], total: 0, startIndex: 0 });
    },
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return wrap('CreateIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      const now = tick();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo, issue }), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findIssueByNodeId(ctx.store, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Issue not found' });
        return wrap('CloseIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = tick();
      return wrap('CloseIssuePayload', { issue: wrap('Issue', { repo: found.repo, issue: found.issue }), clientMutationId: input.clientMutationId ?? null });
    },
    reopenIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findIssueByNodeId(ctx.store, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Issue not found' });
        return wrap('ReopenIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      found.issue.state = 'open';
      found.issue.updatedAt = tick();
      return wrap('ReopenIssuePayload', { issue: wrap('Issue', { repo: found.repo, issue: found.issue }), clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return wrap('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!ctx.store.branchTip(repo, head) || !ctx.store.branchTip(repo, base)) {
        ctx.errors.push({ message: 'Head or base branch not found' });
        return wrap('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const now = tick();
      const number = repo.nextNumber++;
      const pull: PullRec = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, {
        number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: true,
      });
      return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pull }), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findPullByNodeId(ctx.store, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Pull request not found' });
        return wrap('MergePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const outcome = performMerge(ctx.store, found.repo, found.pull, method === 'merge' ? 'merge' : 'squash', {
        commitTitle: typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined,
        commitMessage: typeof input.commitBody === 'string' ? input.commitBody : undefined,
      });
      if (!outcome.ok) ctx.errors.push({ message: outcome.message });
      return wrap('MergePullRequestPayload', { pullRequest: wrap('PullRequest', { repo: found.repo, pull: found.pull }), clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findIssueByNodeId(ctx.store, String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Subject not found' });
        return wrap('AddCommentPayload', { commentEdge: null, clientMutationId: input.clientMutationId ?? null });
      }
      const comment = { id: ctx.store.nextCommentId(), body: String(input.body ?? ''), userLogin: VIEWER.login, createdAt: tick() };
      found.issue.comments.push(comment);
      const node = wrap('IssueComment', { repo: found.repo, issue: found.issue, comment });
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', { cursor: cursorOf(found.issue.comments.length - 1), node }),
        subject: wrap('Issue', { repo: found.repo, issue: found.issue }),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },
  User: {
    id: () => userNodeId(),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    databaseId: () => VIEWER.id,
    isViewer: () => true,
    url: () => `https://forge.invalid/${VIEWER.login}`,
    avatarUrl: () => '',
  },
  Repository: {
    id: (_c, s) => repoNodeId(s?.value as Repo),
    databaseId: (_c, s) => (s?.value as Repo).id,
    name: (_c, s) => (s?.value as Repo).name,
    nameWithOwner: (_c, s) => `${(s?.value as Repo).owner}/${(s?.value as Repo).name}`,
    description: (_c, s) => (s?.value as Repo).description,
    isPrivate: (_c, s) => (s?.value as Repo).isPrivate,
    isFork: () => false,
    url: (_c, s) => `https://forge.invalid/${(s?.value as Repo).owner}/${(s?.value as Repo).name}`,
    createdAt: (_c, s) => (s?.value as Repo).createdAt.toISOString(),
    updatedAt: (_c, s) => (s?.value as Repo).updatedAt.toISOString(),
    pushedAt: (_c, s) => (s?.value as Repo).updatedAt.toISOString(),
    owner: (_c, s) => wrap('User', { login: (s?.value as Repo).owner }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    stargazerCount: () => 0,
    forkCount: () => 0,
    primaryLanguage: () => null,
    defaultBranchRef: (ctx, s) => {
      const repo = s?.value as Repo;
      const tip = ctx.store.branchTip(repo, repo.defaultBranch);
      if (!tip) return null;
      return wrap('Ref', { name: repo.defaultBranch, oid: tip });
    },
    issue: (_c, s, args) => {
      const repo = s?.value as Repo;
      const issue = repo.issues.get(Number(args.get('number')));
      if (!issue || issue.isPull) return null;
      return wrap('Issue', { repo, issue });
    },
    issues: (_c, s, args) => {
      const repo = s?.value as Repo;
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      const states = args.get('states') as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const ascending = orderBy?.direction === 'ASC';
      list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
      const page = paginate(list, args);
      return wrap('IssueConnection', {
        items: page.items.map((issue) => wrap('Issue', { repo, issue })),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'Issue',
      });
    },
    pullRequest: (_c, s, args) => {
      const repo = s?.value as Repo;
      const pull = repo.pulls.get(Number(args.get('number')));
      return pull ? wrap('PullRequest', { repo, pull }) : null;
    },
    pullRequests: (_c, s, args) => {
      const repo = s?.value as Repo;
      let list = [...repo.pulls.values()];
      const states = args.get('states') as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states);
        list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      list.sort((a, b) => b.number - a.number);
      const page = paginate(list, args);
      return wrap('PullRequestConnection', {
        items: page.items.map((pull) => wrap('PullRequest', { repo, pull })),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'PullRequest',
      });
    },
    labels: (_c, s, args) => {
      const repo = s?.value as Repo;
      const list = [...repo.labels.values()];
      const page = paginate(list, args);
      return wrap('LabelConnection', {
        items: page.items.map((label) => wrap('Label', { repo, label })),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'Label',
      });
    },
  },
  Ref: {
    name: (_c, s) => (s?.value as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (_c, s) => wrap('Commit', { oid: (s?.value as { oid: string }).oid }),
  },
  Commit: {
    id: (_c, s) => nodeId('Commit', (s?.value as { oid: string }).oid),
    oid: (_c, s) => (s?.value as { oid: string }).oid,
    message: (ctx, s) => ctx.store.readCommit((s?.value as { oid: string }).oid)?.message ?? '',
    committedDate: () => new Date(1_700_000_000_000).toISOString(),
  },
  Issue: {
    id: (_c, s) => issueNodeId((s?.value as { repo: Repo }).repo, (s?.value as { issue: IssueRec }).issue),
    databaseId: (_c, s) => (s?.value as { repo: Repo }).repo.id * 1_000_000 + (s?.value as { issue: IssueRec }).issue.number,
    number: (_c, s) => (s?.value as { issue: IssueRec }).issue.number,
    title: (_c, s) => (s?.value as { issue: IssueRec }).issue.title,
    body: (_c, s) => (s?.value as { issue: IssueRec }).issue.body,
    state: (_c, s) => ((s?.value as { issue: IssueRec }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => wrap('User', VIEWER),
    repository: (_c, s) => wrap('Repository', (s?.value as { repo: Repo }).repo),
    createdAt: (_c, s) => (s?.value as { issue: IssueRec }).issue.createdAt.toISOString(),
    updatedAt: (_c, s) => (s?.value as { issue: IssueRec }).issue.updatedAt.toISOString(),
    closedAt: (_c, s) => {
      const issue = (s?.value as { issue: IssueRec }).issue;
      return issue.state === 'closed' ? issue.updatedAt.toISOString() : null;
    },
    url: (_c, s) => {
      const { repo, issue } = s?.value as { repo: Repo; issue: IssueRec };
      return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    viewerCanUpdate: () => true,
    labels: (_c, s, args) => {
      const { repo, issue } = s?.value as { repo: Repo; issue: IssueRec };
      const list = issue.labels.map((name) => repo.labels.get(name)).filter((label) => label !== undefined);
      const page = paginate(list, args);
      return wrap('LabelConnection', {
        items: page.items.map((label) => wrap('Label', { repo, label })),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'Label',
      });
    },
    comments: (_c, s, args) => {
      const { repo, issue } = s?.value as { repo: Repo; issue: IssueRec };
      const page = paginate(issue.comments, args);
      return wrap('IssueCommentConnection', {
        items: page.items.map((comment) => wrap('IssueComment', { repo, issue, comment })),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'IssueComment',
      });
    },
  },
  PullRequest: {
    id: (_c, s) => pullNodeId((s?.value as { repo: Repo }).repo, (s?.value as { pull: PullRec }).pull),
    databaseId: (_c, s) => (s?.value as { repo: Repo }).repo.id * 1_000_000 + (s?.value as { pull: PullRec }).pull.number,
    number: (_c, s) => (s?.value as { pull: PullRec }).pull.number,
    title: (_c, s) => (s?.value as { pull: PullRec }).pull.title,
    body: (_c, s) => (s?.value as { pull: PullRec }).pull.body,
    state: (_c, s) => {
      const pull = (s?.value as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_c, s) => (s?.value as { pull: PullRec }).pull.merged,
    mergedAt: (_c, s) => (s?.value as { pull: PullRec }).pull.mergedAt?.toISOString() ?? null,
    mergeCommit: (_c, s) => {
      const pull = (s?.value as { pull: PullRec }).pull;
      return pull.mergeCommitSha ? wrap('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    headRefName: (_c, s) => (s?.value as { pull: PullRec }).pull.headRef,
    baseRefName: (_c, s) => (s?.value as { pull: PullRec }).pull.baseRef,
    headRefOid: (_c, s) => {
      const { repo, pull } = s?.value as { repo: Repo; pull: PullRec };
      return ctx.store.branchTip(repo, pull.headRef) ?? '';
    },
    baseRefOid: (_c, s) => {
      const { repo, pull } = s?.value as { repo: Repo; pull: PullRec };
      return ctx.store.branchTip(repo, pull.baseRef) ?? '';
    },
    mergeable: (ctx, s) => {
      const { repo, pull } = s?.value as { repo: Repo; pull: PullRec };
      if (pull.state !== 'open') return 'UNKNOWN';
      const mergeable = computeMergeable(ctx.store, repo, pull);
      return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
    author: () => wrap('User', VIEWER),
    repository: (_c, s) => wrap('Repository', (s?.value as { repo: Repo }).repo),
    createdAt: (_c, s) => (s?.value as { pull: PullRec }).pull.createdAt.toISOString(),
    updatedAt: (_c, s) => (s?.value as { pull: PullRec }).pull.updatedAt.toISOString(),
    closedAt: (_c, s) => {
      const pull = (s?.value as { pull: PullRec }).pull;
      return pull.state === 'closed' ? pull.updatedAt.toISOString() : null;
    },
    url: (_c, s) => {
      const { repo, pull } = s?.value as { repo: Repo; pull: PullRec };
      return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    files: (ctx, s, args) => {
      const { repo, pull } = s?.value as { repo: Repo; pull: PullRec };
      const files = pullFiles(ctx.store, repo, pull);
      const page = paginate(files, args);
      return wrap('PullRequestChangedFileConnection', {
        items: page.items.map((file) => wrap('PullRequestChangedFile', file)),
        total: page.total,
        startIndex: page.startIndex,
        kind: 'PullRequestChangedFile',
      });
    },
    additions: (ctx, s) => pullFiles(ctx.store, (s?.value as { repo: Repo }).repo, (s?.value as { pull: PullRec }).pull).reduce((sum, f) => sum + f.additions, 0),
    deletions: (ctx, s) => pullFiles(ctx.store, (s?.value as { repo: Repo }).repo, (s?.value as { pull: PullRec }).pull).reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: (ctx, s) => pullFiles(ctx.store, (s?.value as { repo: Repo }).repo, (s?.value as { pull: PullRec }).pull).length,
  },
  IssueComment: {
    id: (_c, s) => commentNodeId((s?.value as { comment: { id: number } }).comment.id),
    databaseId: (_c, s) => (s?.value as { comment: { id: number } }).comment.id,
    body: (_c, s) => (s?.value as { comment: { body: string } }).comment.body,
    author: () => wrap('User', VIEWER),
    createdAt: (_c, s) => (s?.value as { comment: { createdAt: Date } }).comment.createdAt.toISOString(),
    updatedAt: (_c, s) => (s?.value as { comment: { createdAt: Date } }).comment.createdAt.toISOString(),
    url: (_c, s) => {
      const { repo, issue, comment } = s?.value as { repo: Repo; issue: IssueRec; comment: { id: number } };
      return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
    },
  },
  Label: {
    id: (_c, s) => nodeId('Label', (s?.value as { repo: Repo }).repo.id, (s?.value as { label: { name: string } }).label.name),
    name: (_c, s) => (s?.value as { label: { name: string } }).label.name,
    color: (_c, s) => (s?.value as { label: { color: string } }).label.color,
    description: (_c, s) => (s?.value as { label: { description: string } }).label.description,
  },
  PullRequestChangedFile: {
    path: (_c, s) => (s?.value as { path: string }).path,
    additions: (_c, s) => (s?.value as { additions: number }).additions,
    deletions: (_c, s) => (s?.value as { deletions: number }).deletions,
    changeType: (_c, s) => (s?.value as { changeType: string }).changeType,
  },
  RateLimit: {
    limit: () => 5000,
    cost: () => 1,
    remaining: () => 4999,
    used: () => 1,
    nodeCount: () => 0,
    resetAt: () => new Date(1_700_000_000_000).toISOString(),
  },
};

// Payload types resolve through their stored fields.
for (const payloadType of ['CreateIssuePayload', 'CloseIssuePayload', 'ReopenIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payloadType] = {
    clientMutationId: (_c, s) => (s?.value as { clientMutationId: unknown }).clientMutationId ?? null,
    issue: (_c, s) => (s?.value as { issue: unknown }).issue ?? null,
    pullRequest: (_c, s) => (s?.value as { pullRequest: unknown }).pullRequest ?? null,
    commentEdge: (_c, s) => (s?.value as { commentEdge: unknown }).commentEdge ?? null,
    subject: (_c, s) => (s?.value as { subject: unknown }).subject ?? null,
  };
}
RESOLVERS.IssueCommentEdge = {
  cursor: (_c, s) => (s?.value as { cursor: string }).cursor,
  node: (_c, s) => (s?.value as { node: unknown }).node,
};

// Connections resolve generically.
for (const [connectionType, edgeType] of [
  ['IssueConnection', 'IssueEdge'],
  ['PullRequestConnection', 'PullRequestEdge'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFileEdge'],
  ['LabelConnection', 'LabelEdge'],
  ['IssueCommentConnection', 'IssueCommentEdge'],
  ['SearchResultItemConnection', 'SearchResultItemEdge'],
] as const) {
  RESOLVERS[connectionType] = {
    nodes: (_c, s) => (s?.value as { items: GqlObject[] }).items,
    edges: (_c, s) => {
      const value = s?.value as { items: GqlObject[]; startIndex: number };
      return value.items.map((item, i) => wrap(edgeType, { cursor: cursorOf(value.startIndex + i), node: item }));
    },
    pageInfo: (_c, s) => {
      const value = s?.value as { items: GqlObject[]; total: number; startIndex: number };
      const endIndex = value.startIndex + value.items.length;
      return wrap('PageInfo', {
        hasNextPage: endIndex < value.total,
        hasPreviousPage: value.startIndex > 0,
        startCursor: value.items.length > 0 ? cursorOf(value.startIndex) : null,
        endCursor: value.items.length > 0 ? cursorOf(endIndex - 1) : null,
      });
    },
    totalCount: (_c, s) => (s?.value as { total: number }).total,
    issueCount: (_c, s) => (s?.value as { total: number }).total,
    repositoryCount: () => 0,
    userCount: () => 0,
  };
  RESOLVERS[edgeType] = {
    cursor: (_c, s) => (s?.value as { cursor: string }).cursor,
    node: (_c, s) => (s?.value as { node: unknown }).node,
  };
}
RESOLVERS.PageInfo = {
  hasNextPage: (_c, s) => (s?.value as { hasNextPage: boolean }).hasNextPage,
  hasPreviousPage: (_c, s) => (s?.value as { hasPreviousPage: boolean }).hasPreviousPage,
  startCursor: (_c, s) => (s?.value as { startCursor: string | null }).startCursor,
  endCursor: (_c, s) => (s?.value as { endCursor: string | null }).endCursor,
};

// Introspection types.
RESOLVERS.__Type = {
  name: (_c, s) => (s?.value as { name: string }).name,
  kind: (_c, s) => typeKind((s?.value as { name: string }).name),
  description: () => null,
  fields: (_c, s, args) => {
    void args;
    const name = (s?.value as { name: string }).name;
    const defs = OBJECT_FIELDS[name];
    if (!defs) return null;
    return defs.map((def) => wrap('__Field', def));
  },
  enumValues: (_c, s) => {
    const name = (s?.value as { name: string }).name;
    const values = ENUM_VALUES[name];
    if (!values) return null;
    return values.map((value) => wrap('__EnumValue', { name: value }));
  },
  possibleTypes: () => null,
  inputFields: () => null,
  ofType: () => null,
  specifiedByURL: () => null,
  interfaces: () => [],
};
RESOLVERS.__Field = {
  name: (_c, s) => (s?.value as FieldDef).name,
  description: () => null,
  args: () => [],
  type: (_c, s) => wrap('__Type', { name: baseTypeName((s?.value as FieldDef).type) }),
  isDeprecated: () => false,
  deprecationReason: () => null,
};
RESOLVERS.__EnumValue = {
  name: (_c, s) => (s?.value as { name: string }).name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};
RESOLVERS.__Schema = {
  types: () => Object.keys({ ...OBJECT_FIELDS, ...ENUM_VALUES }).map((name) => wrap('__Type', { name })),
  queryType: () => wrap('__Type', { name: 'Query' }),
  mutationType: () => wrap('__Type', { name: 'Mutation' }),
  subscriptionType: () => null,
  directives: () => [],
};

function baseTypeName(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function isKnownField(type: string, field: string): boolean {
  if (field === '__typename' || field === '__type' || field === '__schema') return true;
  const defs = OBJECT_FIELDS[type];
  if (defs) return defs.some((def) => def.name === field);
  // Interface-ish parents fall back to accepting.
  return RESOLVERS[type]?.[field] !== undefined;
}

function executeSelectionSet(ctx: Ctx, source: GqlObject | null, type: string, selections: SelectionNode[], path: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, source, type, fragment.selectionSet, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (!selection.typeCondition || selection.typeCondition === type || type === 'Node' || type === 'SearchResultItem') {
        Object.assign(out, executeSelectionSet(ctx, source, type, selection.selectionSet, path));
      } else if (source && selection.typeCondition === source.__type) {
        Object.assign(out, executeSelectionSet(ctx, source, source.__type, selection.selectionSet, path));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = type;
      continue;
    }
    if (selection.name === '__type') {
      const args = resolveArgs(ctx, selection.args);
      const name = String(args.get('name') ?? '');
      const known = OBJECT_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined || SCALARS.has(name);
      out[key] = known ? completeValue(ctx, wrap('__Type', { name }), '__Type', selection, fieldPath) : null;
      continue;
    }
    if (selection.name === '__schema') {
      out[key] = completeValue(ctx, wrap('__Schema', {}), '__Schema', selection, fieldPath);
      continue;
    }
    if (!isKnownField(type, selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${type}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const resolver = RESOLVERS[type]?.[selection.name];
    const args = resolveArgs(ctx, selection.args);
    const raw = resolver ? resolver(ctx, source, args) : (source?.value as Record<string, unknown>)?.[selection.name] ?? null;
    const fieldDef = OBJECT_FIELDS[type]?.find((def) => def.name === selection.name);
    out[key] = completeValue(ctx, raw, fieldDef ? baseTypeName(fieldDef.type) : 'String', selection, fieldPath);
  }
  return out;
}

function resolveArgs(ctx: Ctx, args: Map<string, ValueNode>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of args) out.set(key, resolveValue(value, ctx.variables));
  return out;
}

function completeValue(ctx: Ctx, raw: unknown, type: string, selection: FieldNode, path: string[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(ctx, item, type, selection, path));
  if (typeof raw === 'object' && raw !== null && '__type' in (raw as Record<string, unknown>)) {
    const obj = raw as GqlObject;
    if (!selection.selectionSet) return obj.value;
    return executeSelectionSet(ctx, obj, obj.__type, selection.selectionSet, path);
  }
  if (selection.selectionSet && typeof raw === 'object') {
    return executeSelectionSet(ctx, wrap(type, raw), type, selection.selectionSet, path);
  }
  return raw;
}

function executeOperation(store: Store, document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, wrap(rootType, {}), rootType, operation.selectionSet, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// -------------------------------------------------------------------------------------------
// Entry point

export function handleGraphQL(store: Store, parsed: unknown): RestResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid request' }] };
    const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') return { errors: [{ message: 'Must provide a query string' }] };
    let document: DocumentNode;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const vars = (typeof variables === 'object' && variables !== null ? variables : {}) as Record<string, unknown>;
    const operations = typeof operationName === 'string' ? document.operations.filter((op) => op.name === operationName) : document.operations;
    if (operations.length === 0) return { errors: [{ message: 'Operation not found' }] };
    if (operations.length === 1) return executeOperation(store, document, operations[0] as OperationNode, vars);
    return { data: operations.map((op) => executeOperation(store, document, op, vars).data) };
  };

  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
