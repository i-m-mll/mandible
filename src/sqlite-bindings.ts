interface Slot { index: number; name?: string; aliases: Set<string> }
const identifier = (char: string | undefined): boolean => char !== undefined && (char.charCodeAt(0) >= 128 || /[A-Za-z0-9_$]/.test(char));
const digit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
const alphabeticParameter = (name: string | undefined): boolean => name !== undefined && name[0] !== "?";

function append(index: Map<string, Slot[]>, key: string, slot: Slot): void {
  const slots = index.get(key);
  if (slots) slots.push(slot);
  else index.set(key, [slot]);
}

/** Parameter tokens follow SQLite tokenize.c; SQL execution remains native. */
export class SqliteBindings {
  private readonly slots = new Map<number, Slot>();
  private highest = 0;
  private readonly byAlias = new Map<string, Slot[]>();
  private readonly byBareAlias = new Map<string, Slot[]>();
  constructor(sql: string) {
    const names = new Map<string, number>();
    for (let i = 0; i < sql.length;) {
      const char = sql[i];
      if (char === "'" || char === '"' || char === "`") {
        i++;
        while (i < sql.length) {
          if (sql[i++] !== char) continue;
          if (sql[i] !== char) break;
          i++;
        }
        continue;
      }
      if (char === "[") { const end = sql.indexOf("]", i + 1); i = end < 0 ? sql.length : end + 1; continue; }
      if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i + 2); i = end < 0 ? sql.length : end + 1; continue; }
      if (sql.startsWith("/*", i)) { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; continue; }
      let name: string | undefined;
      let index: number;
      if (char === "?") {
        const start = i++;
        while (digit(sql[i])) i++;
        if (i === start + 1) index = this.highest + 1;
        else { name = sql.slice(start, i); index = Number(name.slice(1)); }
      } else if (char === ":" || char === "@" || char === "$" || char === "#") {
        const start = i++;
        let characters = 0;
        while (i < sql.length) {
          if (identifier(sql[i])) { i++; characters++; }
          else if (sql.startsWith("::", i)) i += 2;
          else if (sql[i] === "(" && characters > 0) {
            i++;
            while (i < sql.length && !/[\t\n\f\r ]/.test(sql[i]) && sql[i] !== ")") i++;
            if (sql[i] === ")") i++;
            break;
          } else break;
        }
        if (!characters) throw new Error("Unsupported SQLite parameter token");
        name = sql.slice(start, i);
        index = names.get(name) ?? this.highest + 1;
        names.set(name, index);
      } else {
        i++;
        if (identifier(char)) while (identifier(sql[i])) i++;
        continue;
      }
      this.highest = Math.max(this.highest, index);
      const slot = this.slots.get(index) ?? { index, name, aliases: new Set<string>() };
      if (name) { slot.name ??= name; slot.aliases.add(name); }
      this.slots.set(index, slot);
    }
    for (const slot of this.slots.values()) {
      const bare = new Set<string>();
      for (const alias of slot.aliases) {
        append(this.byAlias, alias, slot);
        bare.add(alias.slice(1));
      }
      for (const alias of bare) append(this.byBareAlias, alias, slot);
    }
  }
  resolve(args: any[]): any[] {
    const flattened = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    for (let i = 0; i < flattened.length; i++) {
      if (!Object.hasOwn(flattened, i) || flattened[i] === undefined) throw new Error("SQLite bindings cannot contain omissions or undefined");
    }
    const first = flattened[0];
    const hasNamed = first !== null && typeof first === "object" && !ArrayBuffer.isView(first) && !(first instanceof ArrayBuffer);
    const record = hasNamed ? first as Record<string, unknown> : undefined;
    const positional = hasNamed ? flattened.slice(1) : flattened;
    const assigned = new Map<number, unknown>();
    if (record) {
      for (const key of Object.getOwnPropertyNames(record)) {
        const candidates = this.byAlias.get(key) ?? this.byBareAlias.get(key);
        if (!candidates) continue;
        if (candidates.length !== 1) throw new Error(`Ambiguous SQLite parameter: ${key}`);
        const slot = candidates[0];
        if (assigned.has(slot.index)) throw new Error(`SQLite parameter supplied twice: ${key}`);
        assigned.set(slot.index, record[key]);
      }
    }
    const positionalSlots: number[] = [];
    for (let index = 1; index <= this.highest; index++) {
      const slot = this.slots.get(index);
      if (!alphabeticParameter(slot?.name) && !assigned.has(index)) positionalSlots.push(index);
    }
    if (positional.length > positionalSlots.length) throw new Error("Too many positional SQLite bindings");
    positional.forEach((value, i) => assigned.set(positionalSlots[i], value));
    for (const slot of this.slots.values()) {
      if (!assigned.has(slot.index) || assigned.get(slot.index) === undefined) throw new Error(`Missing SQLite binding: ${slot.name ?? slot.index}`);
    }
    for (const value of assigned.values()) {
      if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Use BigInt for SQLite integers outside the safe Number range");
    }
    const nativeNamed: Record<string, unknown> = Object.create(null);
    const nativePositional: unknown[] = [];
    for (let index = 1; index <= this.highest; index++) {
      const slot = this.slots.get(index);
      if (alphabeticParameter(slot?.name)) nativeNamed[slot!.name!] = assigned.get(index);
      else nativePositional.push(assigned.get(index) ?? null);
    }
    return Object.keys(nativeNamed).length ? [nativeNamed, ...nativePositional] : nativePositional;
  }
}
