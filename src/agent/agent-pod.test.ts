import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import type { McpToolDescriptor } from './types.js';
import {
  parseFrontmatter,
  parseToolFile,
  readAgentPod,
  serializeFrontmatter,
  writeAgentPod,
  type AgentPod,
} from './agent-pod.js';

beforeEach(async () => {
  for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
});

const searchTool: McpToolDescriptor = {
  name: 'search_chart',
  description: 'Search the chart',
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
};

describe('front matter', () => {
  it('parses scalars, block lists and inline lists', () => {
    const { data, body } = parseFrontmatter(
      ['---', 'name: triage', 'description: "Sorts: things"', 'needs:', '  - chart.read', '  - orders.write', 'tags: [a, b]', 'priority: 3', 'draft: false', '---', '# Hi', 'body'].join('\n'),
    );
    expect(data).toEqual({
      name: 'triage',
      description: 'Sorts: things',
      needs: ['chart.read', 'orders.write'],
      tags: ['a', 'b'],
      priority: 3,
      draft: false,
    });
    expect(body).toBe('# Hi\nbody');
  });

  it('treats a document without front matter as body only', () => {
    expect(parseFrontmatter('# just text')).toEqual({ data: {}, body: '# just text' });
  });

  it('round-trips through serialize', () => {
    const data = { name: 'x', description: 'needs: quoting', needs: ['a.b', 'c'], n: 2, flag: true, nothing: null };
    const text = serializeFrontmatter(data, 'Body\n');
    expect(parseFrontmatter(text)).toEqual({ data, body: 'Body\n' });
  });
});

describe('parseToolFile', () => {
  it('accepts one descriptor or an array', () => {
    expect(parseToolFile('t.json', JSON.stringify(searchTool))).toEqual([searchTool]);
    expect(parseToolFile('t.json', JSON.stringify([searchTool, searchTool]))).toHaveLength(2);
  });
  it('rejects malformed files with the path', () => {
    expect(() => parseToolFile('/tools/bad.json', '{')).toThrow(/\/tools\/bad\.json: invalid JSON/);
    expect(() => parseToolFile('/tools/bad.json', '{"name":"x"}')).toThrow(/not an McpToolDescriptor/);
  });
});

describe('readAgentPod / writeAgentPod', () => {
  const pod: AgentPod = {
    agent: {
      frontmatter: { name: 'triage', description: 'Triage nurse', needs: ['chart.read'], model: 'ozwell-1' },
      instructions: '# Triage\n\nBe brief.\n',
    },
    skills: [
      { name: 'vitals', frontmatter: { name: 'vitals', description: 'Record vitals', needs: ['vitals.write'] }, instructions: 'Steps…\n' },
      { name: 'soap', frontmatter: { name: 'soap' }, instructions: 'SOAP note.\n' },
    ],
    tools: [{ file: 'search.json', descriptors: [searchTool] }],
  };

  it('returns null when AGENT.md is absent', async () => {
    expect(await readAgentPod(zfs, '/nope')).toBeNull();
  });

  it('writes the layout and reads it back identically', async () => {
    const written = await writeAgentPod(zfs, '/agents/triage', pod);
    expect(written).toEqual([
      '/agents/triage/AGENT.md',
      '/agents/triage/skills/vitals/SKILL.md',
      '/agents/triage/skills/soap/SKILL.md',
      '/agents/triage/tools/search.json',
    ]);
    expect(await zfs.promises.readFile('/agents/triage/AGENT.md', 'utf8')).toBe(
      '---\nname: triage\ndescription: Triage nurse\nneeds:\n  - chart.read\nmodel: ozwell-1\n---\n# Triage\n\nBe brief.\n',
    );
    const back = await readAgentPod(zfs.promises, '/agents/triage');
    expect(back).toEqual({ ...pod, skills: [pod.skills[1], pod.skills[0]] }); // readdir sorted
  });

  it('skips skill dirs without SKILL.md, ignores non-json in tools/, prunes on request', async () => {
    await writeAgentPod(zfs, '/a', pod);
    await zfs.promises.mkdir('/a/skills/empty');
    await zfs.promises.writeFile('/a/tools/README.md', 'notes');
    const read = await readAgentPod(zfs, '/a');
    expect(read!.skills.map((s) => s.name)).toEqual(['soap', 'vitals']);
    expect(read!.tools.map((t) => t.file)).toEqual(['search.json']);

    await writeAgentPod(zfs, '/a', { ...pod, skills: [pod.skills[0]], tools: [] }, { prune: true });
    // prune removes every non-listed skill dir (including 'empty') and every stray .json
    expect(await zfs.promises.readdir('/a/skills')).toEqual(['vitals']);
    expect(await zfs.promises.readdir('/a/tools')).toEqual(['README.md']);
  });

  it('surfaces malformed tool files', async () => {
    await writeAgentPod(zfs, '/b', { ...pod, tools: [] });
    await zfs.promises.mkdir('/b/tools');
    await zfs.promises.writeFile('/b/tools/x.json', '[]]');
    await expect(readAgentPod(zfs, '/b')).rejects.toThrow(/\/b\/tools\/x\.json/);
  });
});
