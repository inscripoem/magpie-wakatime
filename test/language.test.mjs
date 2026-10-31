import { expect, test } from "bun:test";
import { detectLanguage, languageForFile } from "../src/language.mjs";

const files = (...list) => list.map((file) => `${file}\0`).join("");

test("picks the dominant tracked language and ignores documentation and build output", () => {
  expect(detectLanguage(files("src/app.ts", "src/view.tsx", "src/util.ts", "web/main.js",
    "README.md", "package.json", "dist/bundle.js", "src/types.d.ts", "src/lib.min.js"))).toBe("TypeScript");
  expect(detectLanguage(files("Cargo.toml", "src/main.rs", "src/cache.rs", "docs/guide.md"))).toBe("Rust");
  expect(detectLanguage(files("pkg/server.go", "go.mod", "vendor/legacy.c"))).toBe("Go");
});

test("treats C headers as the surrounding C or C++ sources", () => {
  expect(detectLanguage(files("src/a.c", "include/a.h", "include/b.h"))).toBe("C");
  expect(detectLanguage(files("src/a.cpp", "include/a.hpp", "include/b.h"))).toBe("C++");
});

test("returns nothing when no tracked file carries a recognized language", () => {
  for (const value of ["", "README.md\0", "data.json\0config.yml\0", null, 7]) {
    expect(detectLanguage(value)).toBeNull();
  }
});

test("breaks ties deterministically", () => {
  expect(detectLanguage(files("a.py", "b.rs"))).toBe("Python");
  expect(detectLanguage(files("b.rs", "a.py"))).toBe("Python");
});

test("maps an explicitly named file, including documents and data", () => {
  for (const [file, language] of [
    ["src/app.ts", "TypeScript"], ["C:\\repo\\main.py", "Python"],
    ["notes/README.md", "Markdown"], ["config/app.yaml", "YAML"],
    ["data/rows.csv", "CSV"], ["Dockerfile", "Dockerfile"],
    ["Makefile", "Makefile"], ["CMakeLists.txt", "CMake"],
    ["events.jsonl", "JSON"], ["config.json.example", "JSON"],
    ["foo.bsl", "1C Enterprise"], ["change.patch", null],
    ["run.log", null], ["unknown.bin", null], [null, null], ["", null],
  ]) expect(languageForFile(file)).toBe(language);
});
