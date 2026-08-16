export type ParsedShellInputRedirections = {
  command: string;
  targets: string[];
};

export function readShellRedirectionTarget(
  command: string,
  start: number,
): { target: string; end: number } {
  let target = '';
  let quote: "'" | '"' | null = null;
  let cursor = start;
  while (cursor < command.length) {
    const char = command[cursor];
    if (quote) {
      if (char === quote) {
        quote = null;
        cursor += 1;
        continue;
      }
      if (char === '\\' && quote === '"' && cursor + 1 < command.length) {
        target += command[cursor + 1];
        cursor += 2;
        continue;
      }
      target += char;
      cursor += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      cursor += 1;
      continue;
    }
    if (char === '\\' && cursor + 1 < command.length) {
      target += command[cursor + 1];
      cursor += 2;
      continue;
    }
    if (/\s/.test(char) || /[;&|()<>]/.test(char)) break;
    target += char;
    cursor += 1;
  }
  return { target, end: cursor };
}

export function parseShellInputRedirections(command: string): ParsedShellInputRedirections {
  const targets: string[] = [];
  let stripped = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length;) {
    const char = command[index];
    if (quote) {
      stripped += char;
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        stripped += command[index + 1];
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '\\' && index + 1 < command.length) {
      stripped += char + command[index + 1];
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      stripped += char;
      index += 1;
      continue;
    }
    if (char !== '<') {
      stripped += char;
      index += 1;
      continue;
    }

    const next = command[index + 1];
    if (next === '<') {
      let end = index + 2;
      while (command[end] === '<') end += 1;
      stripped += command.slice(index, end);
      index = end;
      continue;
    }
    if (next === '&' || next === '(') {
      stripped += char + next;
      index += 2;
      continue;
    }

    let cursor = index + (next === '>' ? 2 : 1);
    while (/\s/.test(command[cursor] ?? '')) cursor += 1;
    const parsedTarget = readShellRedirectionTarget(command, cursor);
    if (parsedTarget.target) targets.push(parsedTarget.target);
    stripped += ' ';
    index = parsedTarget.end;
  }

  return { command: stripped, targets };
}

export function shellInputRedirectionParserSource(): string {
  const helperName = readShellRedirectionTarget.name;
  const parserName = parseShellInputRedirections.name;
  if (!helperName || !parserName) throw new Error('Shell input redirection parser names are unavailable');
  const aliases = [
    helperName === 'readShellRedirectionTarget'
      ? ''
      : `const readShellRedirectionTarget = ${helperName};`,
    parserName === 'parseShellInputRedirections'
      ? ''
      : `const parseShellInputRedirections = ${parserName};`,
  ].filter(Boolean);
  return [
    readShellRedirectionTarget.toString(),
    parseShellInputRedirections.toString(),
    ...aliases,
  ].join('\n');
}
