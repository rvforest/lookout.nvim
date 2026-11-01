// helper/review.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
var hash = (text) => createHash("sha256").update(text).digest("hex");
var same = (a, b) => a === null || b === null ? a === b : a.kind === b.kind && a.hash === b.hash;
var Review = class _Review {
  constructor(dir, identity, data) {
    this.dir = dir;
    this.data = data ?? { version: 1, identity, snapshot: "", files: [], checkpoints: {}, notes: [], draft: "", label: "" };
  }
  data;
  writing = Promise.resolve();
  static async load(dir, identity) {
    let data;
    try {
      data = JSON.parse(await readFile(join(dir, `${hash(identity)}.json`), "utf8"));
      if (data?.version !== 1 || data.identity !== identity || !Array.isArray(data.files) || !Array.isArray(data.notes)) throw new Error("Invalid review cache");
      if (data.delivery?.state === "pending") data.delivery = { ...data.delivery, state: "uncertain", reason: "Client closed before host acknowledgement; check the chat before resending." };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new _Review(dir, identity, data);
  }
  save() {
    const content = JSON.stringify(this.data);
    const path = join(this.dir, `${hash(this.data.identity)}.json`);
    const task = this.writing.catch(() => {
    }).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 448 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 384 });
      await rename(temporary, path);
    });
    this.writing = task;
    return task;
  }
  async replace(files, label) {
    this.data.files = files;
    this.data.snapshot = randomUUID();
    this.data.label = label;
    await this.save();
  }
  visible(mode) {
    return this.data.files.map((file) => {
      const marked = Object.hasOwn(this.data.checkpoints, file.id);
      const baseline = mode === "since" && marked ? this.data.checkpoints[file.id] : file.before;
      return { ...file, before: baseline, seen: marked && same(this.data.checkpoints[file.id], file.after) };
    }).filter((file) => {
      if (file.removedFromChangeset && (mode === "all" || !Object.hasOwn(this.data.checkpoints, file.id))) return false;
      return file.before?.kind === "unavailable" || file.after?.kind === "unavailable" || !same(file.before, file.after);
    });
  }
  async seen(id) {
    const ids = Array.isArray(id) ? new Set(id) : void 0;
    const files = this.data.files.filter((file) => ids ? ids.has(file.id) : !id || file.id === id);
    if (files.some((file) => file.before?.kind === "unavailable" || file.after?.kind === "unavailable")) throw new Error("Cannot mark unavailable content seen");
    if (files.some((file) => file.after?.kind === "large")) throw new Error("Oversized files are metadata-only; their content cannot be checkpointed");
    for (const file of files) {
      this.data.checkpoints[file.id] = file.after;
    }
    await this.save();
  }
  async comment(input, mode) {
    if (!input.text.trim()) throw new Error("Comment is empty");
    const file = input.file ? this.visible(mode).find((x) => x.id === input.file) : void 0;
    if (input.file && !file) throw new Error("File is no longer displayed");
    const side = file?.[input.side ?? "after"];
    const first = input.first, last = input.last ?? first;
    if (first !== void 0 && (side?.kind !== "text" || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > side.text.split("\n").length)) throw new Error("Select a valid range in a text diff");
    this.data.notes.push({
      ...input,
      id: randomUUID(),
      snapshot: this.data.snapshot,
      path: file?.path,
      contentHash: side?.hash,
      quote: first === void 0 ? void 0 : side.text.split("\n").slice(first - 1, last).join("\n")
    });
    await this.save();
  }
  feedback() {
    if (this.data.draft) return this.data.draft;
    return this.data.notes.map((note) => {
      const where = note.path ? `${note.path}${note.first ? ` (${note.side ?? "after"} lines ${note.first}\u2013${note.last ?? note.first})` : ""}` : "General feedback";
      const older = note.snapshot !== this.data.snapshot ? " [earlier snapshot]" : "";
      return `${where}${older}
${note.text}${note.quote !== void 0 ? `

Snapshot context:
${note.quote.split("\n").map((line) => `> ${line}`).join("\n")}` : ""}`;
    }).join("\n\n---\n\n");
  }
};
export {
  Review,
  hash,
  same
};
