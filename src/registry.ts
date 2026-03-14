import type { Schema, SchemaMap } from "./types.js";

function matchesPattern(pattern: string, name: string): boolean {
  const ps = pattern.split(".");
  const ns = name.split(".");
  if (ps.length !== ns.length) return false;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] !== "*" && ps[i] !== ns[i]) return false;
  }
  return true;
}

function wildcardCount(pattern: string): number {
  return (pattern.match(/\*/g) || []).length;
}

interface ResolvedEntry {
  key: string;
  schema: Schema;
  wildcards: number;
  isExact: boolean;
}

export class Registry {
  private entries: ResolvedEntry[] = [];

  register(schemas: SchemaMap): void {
    for (const [pattern, schema] of Object.entries(schemas)) {
      const idx = this.entries.findIndex((e) => e.key === pattern);
      const isExact = !pattern.includes("*");
      const entry: ResolvedEntry = {
        key: pattern,
        schema,
        wildcards: wildcardCount(pattern),
        isExact,
      };

      if (idx !== -1) {
        this.entries[idx] = entry;
      } else {
        this.entries.push(entry);
      }
    }

    this.entries.sort((a, b) => {
      if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
      return a.wildcards - b.wildcards;
    });
  }

  get patterns(): string[] {
    return this.entries.map((e) => e.key);
  }

  resolve(eventName: string): { key: string; schema: Schema } | null {
    for (const entry of this.entries) {
      if (matchesPattern(entry.key, eventName)) {
        return { key: entry.key, schema: entry.schema };
      }
    }
    return null;
  }

  matchesAny(eventName: string, patterns: readonly string[]): boolean {
    for (const pattern of patterns) {
      if (matchesPattern(pattern, eventName)) return true;
    }
    return false;
  }
}
