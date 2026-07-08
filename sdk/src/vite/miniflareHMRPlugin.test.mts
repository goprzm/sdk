import { describe, expect, it } from "vitest";
import {
  getImportSignature,
  hasEntryAsAncestor,
} from "./miniflareHMRPlugin.mjs";

interface MockModule {
  file: string;
  importers: Set<MockModule>;
}

const createModule = (file: string): MockModule => ({
  file,
  importers: new Set(),
});

describe("hasEntryAsAncestor", () => {
  it("should return true if the entry file is a direct importer", () => {
    const entry = createModule("entry.js");
    const mod = createModule("mod.js");
    mod.importers.add(entry);

    expect(hasEntryAsAncestor({ module: mod, entryFile: "entry.js" })).toBe(
      true,
    );
  });

  it("should return true if the entry file is an indirect importer", () => {
    const entry = createModule("entry.js");
    const importer1 = createModule("importer1.js");
    const mod = createModule("mod.js");

    importer1.importers.add(entry);
    mod.importers.add(importer1);

    expect(hasEntryAsAncestor({ module: mod, entryFile: "entry.js" })).toBe(
      true,
    );
  });

  it("should return false if the entry file is not an importer", () => {
    const entry = createModule("entry.js");
    const other = createModule("other.js");
    const mod = createModule("mod.js");

    mod.importers.add(other);

    expect(hasEntryAsAncestor({ module: mod, entryFile: "entry.js" })).toBe(
      false,
    );
  });

  it("should handle circular dependencies", () => {
    const entry = createModule("entry.js");
    const modA = createModule("modA.js");
    const modB = createModule("modB.js");

    modA.importers.add(entry);
    modA.importers.add(modB);
    modB.importers.add(modA);

    expect(hasEntryAsAncestor({ module: modB, entryFile: "entry.js" })).toBe(
      true,
    );
  });

  it("should return false for a module with no importers", () => {
    const mod = createModule("mod.js");
    expect(hasEntryAsAncestor({ module: mod, entryFile: "entry.js" })).toBe(
      false,
    );
  });
});

describe("getImportSignature", () => {
  // The directive sub-scan is skipped when a changed file's import signature is
  // unchanged. These tests pin the contract that determines that decision:
  // the signature must be stable across edits that cannot introduce a new
  // dependency, and must change when the set of imported modules changes.

  it("is unchanged when only the body/comments/whitespace change", () => {
    const before = `import { a } from "./a"\nexport function C() { return a }\n`;
    const after = `import { a } from "./a"\n// tweak\nexport function C() {\n  return a + 1\n}\n`;
    expect(getImportSignature(after)).toBe(getImportSignature(before));
  });

  it("changes when a new import is added (could pull in a directive)", () => {
    const before = `import { a } from "./a"\n`;
    const after = `import { a } from "./a"\nimport { b } from "./b"\n`;
    expect(getImportSignature(after)).not.toBe(getImportSignature(before));
  });

  it("changes when an import is removed", () => {
    const before = `import { a } from "./a"\nimport { b } from "./b"\n`;
    const after = `import { a } from "./a"\n`;
    expect(getImportSignature(after)).not.toBe(getImportSignature(before));
  });

  it("changes when an import specifier is repointed", () => {
    const before = `import { a } from "./a"\n`;
    const after = `import { a } from "./a2"\n`;
    expect(getImportSignature(after)).not.toBe(getImportSignature(before));
  });

  it("is stable across import reordering (no new dependency)", () => {
    const one = `import { a } from "./a"\nimport { b } from "./b"\n`;
    const two = `import { b } from "./b"\nimport { a } from "./a"\n`;
    expect(getImportSignature(two)).toBe(getImportSignature(one));
  });

  it("captures static, re-export, dynamic, and side-effect imports", () => {
    const code = [
      `import { a } from "./a"`,
      `export { x } from "./x"`,
      `const c = await import("./c")`,
      `import "./side-effect"`,
    ].join("\n");
    const sig = getImportSignature(code);
    expect(sig).toContain("./a");
    expect(sig).toContain("./x");
    expect(sig).toContain("./c");
    expect(sig).toContain("./side-effect");
  });
});
