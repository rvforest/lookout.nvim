import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Side = { uri: string; kind: 'text' | 'binary' | 'large' | 'unavailable'; text?: string; hash: string; error?: string };
export type File = { id: string; path: string; before: Side | null; after: Side | null; removedFromChangeset?: boolean };
export type Note = { id: string; file?: string; path?: string; side?: 'before' | 'after'; first?: number; last?: number; quote?: string; contentHash?: string; text: string; snapshot: string };
export type Delivery = { id: string; state: 'pending' | 'accepted' | 'failed' | 'uncertain'; text: string; reason?: string };
export type ReviewData = {
  version: 1; identity: string; snapshot: string; files: File[];
  checkpoints: Record<string, Side | null>; notes: Note[]; draft: string;
  delivery?: Delivery; label: string;
};
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const same = (a: Side | null, b: Side | null) => a === null || b === null ? a === b : a.kind === b.kind && a.hash === b.hash;

export class Review {
  data: ReviewData;
  private writing = Promise.resolve();
  private constructor(private dir: string, identity: string, data?: ReviewData) {
    this.data = data ?? { version: 1, identity, snapshot: '', files: [], checkpoints: {}, notes: [], draft: '', label: '' };
  }
  static async load(dir: string, identity: string) {
    let data: ReviewData | undefined;
    try {
      data = JSON.parse(await readFile(join(dir, `${hash(identity)}.json`), 'utf8'));
      if (data?.version !== 1 || data.identity !== identity || !Array.isArray(data.files) || !Array.isArray(data.notes)) throw new Error('Invalid review cache');
      if (data.delivery?.state === 'pending') data.delivery = { ...data.delivery, state: 'uncertain', reason: 'Client closed before host acknowledgement; check the chat before resending.' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new Review(dir, identity, data);
  }
  save() {
    const content = JSON.stringify(this.data);
    const path = join(this.dir, `${hash(this.data.identity)}.json`);
    const task = this.writing.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.writing = task;
    return task;
  }
  async replace(files: File[], label: string) {
    this.data.files = files;
    this.data.snapshot = randomUUID();
    this.data.label = label;
    await this.save();
  }
  visible(mode: 'since' | 'all') {
    return this.data.files.map((file) => {
      const marked = Object.hasOwn(this.data.checkpoints, file.id);
      const baseline = mode === 'since' && marked ? this.data.checkpoints[file.id] : file.before;
      return { ...file, before: baseline, seen: marked && same(this.data.checkpoints[file.id], file.after) };
    }).filter((file) => {
      if (file.removedFromChangeset && (mode === 'all' || !Object.hasOwn(this.data.checkpoints, file.id))) return false;
      return file.before?.kind === 'unavailable' || file.after?.kind === 'unavailable' || !same(file.before, file.after);
    });
  }
  async seen(id?: string | string[]) {
    const ids = Array.isArray(id) ? new Set(id) : undefined;
    const files = this.data.files.filter((file) => ids ? ids.has(file.id) : !id || file.id === id);
    if (files.some((file) => file.before?.kind === 'unavailable' || file.after?.kind === 'unavailable')) throw new Error('Cannot mark unavailable content seen');
    if (files.some((file) => file.after?.kind === 'large')) throw new Error('Oversized files are metadata-only; their content cannot be checkpointed');
    for (const file of files) {
      this.data.checkpoints[file.id] = file.after;
    }
    await this.save();
  }
  async comment(input: Omit<Note, 'id' | 'snapshot' | 'quote' | 'path'>, mode: 'since' | 'all') {
    if (!input.text.trim()) throw new Error('Comment is empty');
    const file = input.file ? this.visible(mode).find((x) => x.id === input.file) : undefined;
    if (input.file && !file) throw new Error('File is no longer displayed');
    const side = file?.[input.side ?? 'after'];
    const first = input.first, last = input.last ?? first;
    if (first !== undefined && (side?.kind !== 'text' || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last! < first || last! > side.text!.split('\n').length)) throw new Error('Select a valid range in a text diff');
    this.data.notes.push({ ...input, id: randomUUID(), snapshot: this.data.snapshot,
      path: file?.path, contentHash: side?.hash, quote: first === undefined ? undefined : side!.text!.split('\n').slice(first - 1, last).join('\n') });
    await this.save();
  }
  feedback() {
    if (this.data.draft) return this.data.draft;
    return this.data.notes.map((note) => {
      const where = note.path ? `${note.path}${note.first ? ` (${note.side ?? 'after'} lines ${note.first}–${note.last ?? note.first})` : ''}` : 'General feedback';
      const older = note.snapshot !== this.data.snapshot ? ' [earlier snapshot]' : '';
      return `${where}${older}\n${note.text}${note.quote !== undefined ? `\n\nSnapshot context:\n${note.quote.split('\n').map((line) => `> ${line}`).join('\n')}` : ''}`;
    }).join('\n\n---\n\n');
  }
}
