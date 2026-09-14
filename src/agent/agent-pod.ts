/**
 * AgentPod layout (spa-ui-plan P11) — an artipod whose artifacts ARE the agent:
 *
 *   <root>/AGENT.md                 instructions; YAML front matter (name, description, needs, …)
 *   <root>/skills/<name>/SKILL.md   one skill per directory; front matter (name, description, needs, …)
 *   <root>/tools/*.json             McpToolDescriptor (or an array of them) per file
 *
 * Secrets and MCP endpoints are never in the pod — `needs` names capabilities
 * the host grants at run time. This module is the stable contract consumers
 * (editors, harnesses) read and write; it is deliberately dependency-free:
 * the front-matter dialect is the YAML subset of scalars and lists.
 */
import type { PodFs } from '../podfs.js';
import { joinPosix } from '../pathUtils.js';
import type { McpToolDescriptor } from './types.js';

export const AGENT_POD_LAYOUT = {
  agentFile: 'AGENT.md',
  skillsDir: 'skills',
  skillFile: 'SKILL.md',
  toolsDir: 'tools',
} as const;

/** Front-matter values this module round-trips: scalars and flat lists. */
export type FrontmatterValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type Frontmatter = Record<string, FrontmatterValue | undefined>;

export interface AgentFrontmatter extends Frontmatter {
  name?: string;
  description?: string;
  /** Capability names the agent requests; the host maps them to grants. */
  needs?: string[];
  /** Preferred model id (advisory; the venue decides). */
  model?: string;
}

export interface SkillFrontmatter extends Frontmatter {
  name?: string;
  description?: string;
  needs?: string[];
}

export interface AgentDefinition {
  frontmatter: AgentFrontmatter;
  /** Markdown body after the front matter. */
  instructions: string;
}

export interface AgentSkill {
  /** Directory name under `skills/` (the skill's identity). */
  name: string;
  frontmatter: SkillFrontmatter;
  instructions: string;
}

export interface AgentTool {
  /** File name under `tools/` (with `.json`). */
  file: string;
  descriptors: McpToolDescriptor[];
}

export interface AgentPod {
  agent: AgentDefinition;
  skills: AgentSkill[];
  tools: AgentTool[];
}

/** Anything with a node-style promises API (`ZenFsLike` passes as `zfs.promises` or directly). */
export type AgentPodFs = Pick<PodFs, 'readFile' | 'writeFile' | 'readdir' | 'mkdir' | 'stat' | 'rm'>;

function fsOf(fs: AgentPodFs | { promises: AgentPodFs }): AgentPodFs {
  return 'promises' in fs && typeof (fs as { promises: unknown }).promises === 'object'
    ? (fs as { promises: AgentPodFs }).promises
    : (fs as AgentPodFs);
}

// ── front matter ──────────────────────────────────────────────────────────

function parseScalar(raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\(["\\nt])/g, (_, c: string) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' })[c]!) : inner.replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInlineList(s: string): Array<string | number | boolean | null> {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(parseScalar);
}

/** Split `---` front matter from a Markdown document. Missing/invalid block ⇒ `{}` + whole text. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  let pendingKey: string | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && pendingKey) {
      (data[pendingKey] as Array<string | number | boolean | null>).push(parseScalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (!kv) throw new Error(`front matter: cannot parse line '${line}'`);
    const [, key, rest = ''] = kv;
    const value = rest.trim();
    if (value === '') {
      data[key] = [];
      pendingKey = key;
    } else {
      data[key] = value.startsWith('[') && value.endsWith(']') ? parseInlineList(value) : parseScalar(value);
      pendingKey = null;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function serializeScalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  const plainSafe = /^[A-Za-z0-9_][A-Za-z0-9 _./@-]*$/.test(v) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v);
  return plainSafe ? v : JSON.stringify(v);
}

/** Render `---` front matter + body. Keys with `undefined` values are skipped. */
export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const out: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${serializeScalar(item)}`);
    } else {
      out.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  out.push('---', '');
  return out.join('\n') + body;
}

// ── tools ────────────────────────────────────────────────────────────────

function isDescriptor(x: unknown): x is McpToolDescriptor {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  const schema = d.inputSchema as Record<string, unknown> | undefined;
  return (
    typeof d.name === 'string' &&
    typeof d.description === 'string' &&
    !!schema &&
    schema.type === 'object' &&
    typeof schema.properties === 'object'
  );
}

/** Parse one `tools/*.json` file: a descriptor or an array of descriptors. */
export function parseToolFile(file: string, text: string): McpToolDescriptor[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: invalid JSON — ${(e as Error).message}`);
  }
  const list = Array.isArray(json) ? json : [json];
  return list.map((d, i) => {
    if (!isDescriptor(d)) {
      throw new Error(`${file}${Array.isArray(json) ? `[${i}]` : ''}: not an McpToolDescriptor (name, description, inputSchema{type:'object',properties})`);
    }
    return d;
  });
}

// ── read / write ─────────────────────────────────────────────────────────

async function exists(fs: AgentPodFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(fs: AgentPodFs, path: string): Promise<string[]> {
  return (await exists(fs, path)) ? (await fs.readdir(path)).sort() : [];
}

/**
 * Read an AgentPod rooted at `root`. Returns `null` when `<root>/AGENT.md`
 * is absent (not an AgentPod). Skill directories without SKILL.md are
 * skipped; malformed tool files throw with their path.
 */
export async function readAgentPod(fs: AgentPodFs | { promises: AgentPodFs }, root = '/'): Promise<AgentPod | null> {
  const f = fsOf(fs);
  const agentPath = joinPosix(root, AGENT_POD_LAYOUT.agentFile);
  if (!(await exists(f, agentPath))) return null;
  const agentDoc = parseFrontmatter(await f.readFile(agentPath, 'utf-8'));
  const agent: AgentDefinition = { frontmatter: agentDoc.data as AgentFrontmatter, instructions: agentDoc.body };

  const skills: AgentSkill[] = [];
  const skillsDir = joinPosix(root, AGENT_POD_LAYOUT.skillsDir);
  for (const name of await listDir(f, skillsDir)) {
    const skillPath = joinPosix(skillsDir, name, AGENT_POD_LAYOUT.skillFile);
    if (!(await exists(f, skillPath))) continue;
    const doc = parseFrontmatter(await f.readFile(skillPath, 'utf-8'));
    skills.push({ name, frontmatter: doc.data as SkillFrontmatter, instructions: doc.body });
  }

  const tools: AgentTool[] = [];
  const toolsDir = joinPosix(root, AGENT_POD_LAYOUT.toolsDir);
  for (const file of await listDir(f, toolsDir)) {
    if (!file.endsWith('.json')) continue;
    const path = joinPosix(toolsDir, file);
    tools.push({ file, descriptors: parseToolFile(path, await f.readFile(path, 'utf-8')) });
  }

  return { agent, skills, tools };
}

/**
 * Write an AgentPod at `root` (parents created). Only the files described
 * are written; with `prune` skills/tools on disk that are not in `pod` are
 * removed so the layout mirrors `pod` exactly.
 */
export async function writeAgentPod(
  fs: AgentPodFs | { promises: AgentPodFs },
  root: string,
  pod: AgentPod,
  opts: { prune?: boolean } = {},
): Promise<string[]> {
  const f = fsOf(fs);
  const written: string[] = [];
  await f.mkdir(root, { recursive: true });

  const agentPath = joinPosix(root, AGENT_POD_LAYOUT.agentFile);
  await f.writeFile(agentPath, serializeFrontmatter(pod.agent.frontmatter, pod.agent.instructions));
  written.push(agentPath);

  const skillsDir = joinPosix(root, AGENT_POD_LAYOUT.skillsDir);
  for (const skill of pod.skills) {
    if (!/^[A-Za-z0-9_.-]+$/.test(skill.name) || skill.name.startsWith('.')) {
      throw new Error(`writeAgentPod: invalid skill name '${skill.name}'`);
    }
    const dir = joinPosix(skillsDir, skill.name);
    await f.mkdir(dir, { recursive: true });
    const path = joinPosix(dir, AGENT_POD_LAYOUT.skillFile);
    await f.writeFile(path, serializeFrontmatter(skill.frontmatter, skill.instructions));
    written.push(path);
  }

  const toolsDir = joinPosix(root, AGENT_POD_LAYOUT.toolsDir);
  if (pod.tools.length) await f.mkdir(toolsDir, { recursive: true });
  for (const tool of pod.tools) {
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(tool.file) || tool.file.startsWith('.')) {
      throw new Error(`writeAgentPod: invalid tool file name '${tool.file}'`);
    }
    const path = joinPosix(toolsDir, tool.file);
    const body = tool.descriptors.length === 1 ? tool.descriptors[0] : tool.descriptors;
    await f.writeFile(path, JSON.stringify(body, null, 2) + '\n');
    written.push(path);
  }

  if (opts.prune) {
    const keepSkills = new Set(pod.skills.map((s) => s.name));
    for (const name of await listDir(f, skillsDir)) {
      if (!keepSkills.has(name)) await f.rm(joinPosix(skillsDir, name), { recursive: true, force: true });
    }
    const keepTools = new Set(pod.tools.map((t) => t.file));
    for (const file of await listDir(f, toolsDir)) {
      if (file.endsWith('.json') && !keepTools.has(file)) await f.rm(joinPosix(toolsDir, file), { force: true });
    }
  }

  return written;
}
