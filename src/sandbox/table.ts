/** Shared column layout for the shell's table-shaped commands. */
export function renderTable(
  header: string[],
  rows: string[][],
  rightAligned: number[] = [],
): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (rightAligned.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join(' ')
      .trimEnd();
  return `${[line(header), ...rows.map(line)].join('\n')}\n`;
}
