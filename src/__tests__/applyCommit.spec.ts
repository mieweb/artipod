import { ActionType, applyCommit, applyCommitAsync, type Commit } from '../tools/applyPatchParser.js';

function sampleCommit(): Commit {
  return {
    changes: {
      'added.txt': { type: ActionType.ADD, newContent: 'new' },
      'edit.txt': { type: ActionType.UPDATE, oldContent: 'a', newContent: 'b' },
      'from.txt': { type: ActionType.UPDATE, oldContent: 'm', newContent: 'moved', movePath: 'to.txt' },
      'old.txt': { type: ActionType.DELETE },
    },
  };
}

const expectedCalls = [
  'write added.txt new',
  'write edit.txt b',
  'write to.txt moved',
  'remove from.txt',
  'remove old.txt',
];

describe('applyCommit', () => {
  it('stays synchronous and applies every change in order', () => {
    const calls: string[] = [];
    const result = applyCommit(
      sampleCommit(),
      (path, content) => { calls.push(`write ${path} ${content}`); },
      (path) => { calls.push(`remove ${path}`); }
    );

    expect(result).toBeUndefined();
    expect(calls).toEqual(expectedCalls);
  });

  it('keeps the source when a move targets the same file', () => {
    const calls: string[] = [];
    applyCommit(
      { changes: { 'same.txt': { type: ActionType.UPDATE, newContent: 'x', movePath: './same.txt' } } },
      (path) => { calls.push(`write ${path}`); },
      (path) => { calls.push(`remove ${path}`); },
      (a, b) => a.replace(/^\.\//, '') === b.replace(/^\.\//, '')
    );

    expect(calls).toEqual(['write same.txt']);
  });
});

describe('applyCommitAsync', () => {
  it('awaits each change before starting the next', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const track = async (call: string) => {
      inFlight++;
      expect(inFlight).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      calls.push(call);
      inFlight--;
    };

    await applyCommitAsync(
      sampleCommit(),
      (path, content) => track(`write ${path} ${content}`),
      (path) => track(`remove ${path}`)
    );

    expect(calls).toEqual(expectedCalls);
  });
});
