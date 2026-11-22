// mend: one patch tool for every AI edit format.
//
// Applies an edit that an AI model wrote to a tree of text files, in one of
// four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls),
// to the specification in SPEC.md. Every file is changed or nothing is.
//
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether its text ends with that break. */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function fileInfo(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line as tier t compares it: 0 exact, 1 trailing whitespace off, 2 both ends off. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trailWS(line);
  return trimWS(line);
}

/** 0-based positions where O occurs in lines at the given tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const normO = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== normO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once; strict tries tier 0 only. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * The lines N writes when it replaces O at position i of the file's lines.
 * ctx maps an index of N to the index of O it is a context line of: a context
 * line is written as the file's own matched line, never the patch's. At tier 2
 * every other line of N is re-indented from O's first line's leading
 * whitespace P to the file's first matched line's leading whitespace F.
 */
function buildNew(
  fileLines: string[],
  o: string[],
  n: string[],
  ctx: Map<number, number>,
  i: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const F = leadWS(fileLines[i] ?? '');
  const P = leadWS(o.length > 0 ? o[0]! : '');
  for (let j = 0; j < n.length; j++) {
    const cj = ctx.get(j);
    if (cj !== undefined) {
      out.push(fileLines[i + cj]!);
    } else if (tier === 2) {
      const line = n[j]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
      else out.push(line);
    } else {
      out.push(n[j]!);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const info = fileInfo(before);
      if (line < 0 || line > info.lines.length) throw new Fail('no-match', p);
      info.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(info));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctx: Map<number, number>;
  noNL: boolean;
  plusNoNL: boolean;
  hasPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): { old: string; new: string } | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { old: x, new: y };
}

/** A ---/+++ path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function parsePatchPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1]!, 10);
}

/** A hunk body starting at lines[start]; returns the hunk and the next line index. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      body.push(line);
      i++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const line of body) {
    if (line.startsWith('\\')) continue;
    if (line === '') {
      ctx.set(n.length, o.length);
      o.push('');
      n.push('');
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      ctx.set(n.length, o.length);
      o.push(content);
      n.push(content);
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push(line.slice(1));
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const line = body[k]!;
    if (line === '' || line.startsWith(' ') || line.startsWith('+')) lastCtxPlus = k;
    if (line.startsWith('+')) lastPlus = k;
  }
  const follows = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return {
    hunk: {
      a,
      o,
      n,
      ctx,
      noNL: follows(lastCtxPlus),
      plusNoNL: follows(lastPlus),
      hasPlus: lastPlus >= 0,
    },
    next: i,
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  let cur: UniSection | null = null;
  let inHeader = false;
  let seenDashPlus = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (!dg) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: dg.old, newPath: dg.new, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      seenDashPlus = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur && inHeader && !seenDashPlus) {
        cur.oldPath = parsePatchPath(line);
        cur.newPath = parsePatchPath(lines[i + 1]!);
        seenDashPlus = true;
        i += 2;
        continue;
      }
      cur = {
        oldPath: parsePatchPath(line),
        newPath: parsePatchPath(lines[i + 1]!),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      seenDashPlus = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1, a);
      cur.hunks.push(body.hunk);
      inHeader = false;
      i = body.next;
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = parsePatchPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!seenDashPlus) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!seenDashPlus) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => makeUniEdit(s, strict));
}

/** Apply one hunk to the file's lines; d is the length delta of this section's hunks so far. */
function applyUniHunk(
  lines: string[],
  finalFlag: boolean,
  h: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean } {
  if (h.o.length === 0) {
    const pos = Math.min(h.a + d, lines.length);
    const out = [...lines.slice(0, pos), ...h.n, ...lines.slice(pos)];
    return { lines: out, final: pos === lines.length ? !h.noNL : finalFlag };
  }
  const found = findTier(lines, h.o, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const replacement = buildNew(lines, h.o, h.n, h.ctx, best, found.tier);
  const out = [...lines.slice(0, best), ...replacement, ...lines.slice(best + h.o.length)];
  const final = best + h.o.length === lines.length ? !h.noNL : finalFlag;
  return { lines: out, final };
}

function makeUniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = sec.isDelete || newP === null;
    if (isCreate && isDelete) return;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const contentLines: string[] = [];
      let plusNoNL = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.n.length; j++) {
          if (!h.ctx.has(j)) contentLines.push(h.n[j]!);
        }
        if (h.hasPlus) plusNoNL = h.plusNoNL;
      }
      const content = contentLines.length === 0 ? '' : contentLines.join('\n') + (plusNoNL ? '' : '\n');
      tree.now.set(p, content);
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const info = fileInfo(before);
    let lines = info.lines;
    let finalFlag = info.final;
    let d = 0;
    for (const h of sec.hunks) {
      const res = applyUniHunk(lines, finalFlag, h, d, strict, oldPath);
      lines = res.lines;
      finalFlag = res.final;
      d += h.n.length - h.o.length;
    }
    const resultText = joinFile({ lines, br: info.br, final: finalFlag });
    if (isMove) {
      tree.now.set(newPath, resultText);
      tree.now.set(oldPath, null);
      tree.moves.push({ old: oldPath, new: newPath });
    } else {
      tree.now.set(oldPath, resultText);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const info = fileInfo(before);
    const found = findTier(info.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const replacement = buildNew(info.lines, oldLines, newLines, new Map(), pos, found.tier);
    const outLines = [...info.lines.slice(0, pos), ...replacement, ...info.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: outLines, br: info.br, final: info.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let sIdx = -1;
    for (let k = i; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = k;
        break;
      }
    }
    if (sIdx < 0) break;
    let pathLine: string | null = null;
    for (let k = sIdx - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      pathLine = l.trim();
      break;
    }
    if (pathLine === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      pathLine = prevPath;
    }
    prevPath = pathLine;
    let eqIdx = -1;
    for (let k = sIdx + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    edits.push(makeSREdit(pathLine, lines.slice(sIdx + 1, eqIdx), lines.slice(eqIdx + 1, repIdx), strict));
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: string[];
  ctx: Map<number, number>;
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4AChunk[];
  addLines: string[];
  line: number;
}

function v4aSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4aSectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
  return line.slice(prefix.length).trim();
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    const kind = v4aSectionStart(line);
    if (!kind) throw new Exit2(`error: parse ${i + 1}`);
    const path = v4aSectionPath(line, kind);
    let end = last;
    for (let k = i + 1; k < last; k++) {
      if (v4aSectionStart(lines[k]!)) {
        end = k;
        break;
      }
    }
    const raw = lines.slice(i + 1, end);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(makeV4AEdit({ kind, path, moveTo: null, chunks: [], addLines, line: i + 1 }, strict));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(makeV4AEdit({ kind, path, moveTo: null, chunks: [], addLines: [], line: i + 1 }, strict));
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (j < raw.length && raw[j]!.startsWith('*** Move to:')) {
        moveTo = raw[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (; j < raw.length; j++) {
        const l = raw[j]!;
        if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${i + 2 + j}`);
        if (l.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${i + 2 + j}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, o: [], n: [], ctx: new Map(), eof: false };
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) cur = { anchor: null, o: [], n: [], ctx: new Map(), eof: false };
          if (l === '') {
            cur.ctx.set(cur.n.length, cur.o.length);
            cur.o.push('');
            cur.n.push('');
          } else if (l.startsWith(' ')) {
            const content = l.slice(1);
            cur.ctx.set(cur.n.length, cur.o.length);
            cur.o.push(content);
            cur.n.push(content);
          } else if (l.startsWith('-')) {
            cur.o.push(l.slice(1));
          } else {
            cur.n.push(l.slice(1));
          }
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + j}`);
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4AEdit({ kind, path, moveTo, chunks, addLines: [], line: i + 1 }, strict));
    }
    i = end;
  }
  return edits;
}

function makeV4AEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const path = sec.path;
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const isMove = sec.moveTo !== null;
    if (isMove) {
      if (!safe(sec.moveTo!)) throw new Fail('unsafe', sec.moveTo!);
      if (tree.get(sec.moveTo!) !== null) throw new Fail('exists', sec.moveTo!);
    }
    const info = fileInfo(before);
    let lines = info.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let anchorAt = -1;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && anchorAt < 0; t++) {
          const want = normLine(ch.anchor, t);
          for (let k = cursor; k < lines.length; k++) {
            if (normLine(lines[k]!, t) === want) {
              anchorAt = k;
              break;
            }
          }
        }
        if (anchorAt < 0) throw new Fail('no-match', path);
        cursor = anchorAt + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const out = [...lines.slice(0, pos), ...ch.n, ...lines.slice(pos)];
        lines = out;
        cursor = pos + ch.n.length;
        continue;
      }
      const found = findTierFrom(lines, ch.o, cursor, strict);
      if (!found) throw new Fail('no-match', path);
      let pos = found.pos[0]!;
      if (ch.eof) {
        while (pos !== -1 && pos + ch.o.length !== lines.length) {
          const next = found.pos.find((p) => p > pos);
          if (next === undefined) {
            pos = -1;
            break;
          }
          pos = next;
        }
        if (pos === -1) throw new Fail('no-match', path);
      }
      const replacement = buildNew(lines, ch.o, ch.n, ch.ctx, pos, found.tier);
      lines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + ch.o.length)];
      cursor = pos + replacement.length;
    }
    const resultText = joinFile({ lines, br: info.br, final: info.final });
    if (isMove) {
      tree.now.set(sec.moveTo!, resultText);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: sec.moveTo! });
    } else {
      tree.now.set(path, resultText);
    }
  };
}

/** First tier with an occurrence of O at or after `from`; the positions are all at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const all = occurrences(lines, o, t).filter((p) => p >= from);
    if (all.length > 0) return { tier: t, pos: all };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      suppressed.add(m.old);
      suppressed.add(m.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
