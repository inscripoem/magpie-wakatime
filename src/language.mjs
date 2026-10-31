// Language names match WakaTime's own vocabulary (GET /api/v1/program_languages),
// so a heartbeat's language joins the same series that file heartbeats create.
const BY_EXTENSION = new Map(Object.entries({
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", mts: "TypeScript", cts: "TypeScript", tsx: "TypeScript",
  py: "Python", pyi: "Python", pyw: "Python",
  rb: "Ruby", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  scala: "Scala", sc: "Scala", groovy: "Groovy",
  cs: "C#", fs: "F#", fsi: "F#", fsx: "F#",
  c: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++", ino: "C++",
  m: "Objective-C", mm: "Objective-C++", swift: "Swift",
  php: "PHP", pl: "Perl", pm: "Perl", lua: "Lua", r: "R", jl: "Julia", dart: "Dart",
  hs: "Haskell", ex: "Elixir", exs: "Elixir", erl: "Erlang", hrl: "Erlang",
  clj: "Clojure", cljs: "Clojure", cljc: "Clojure",
  ml: "OCaml", mli: "OCaml", nim: "Nim", zig: "Zig", sol: "Solidity",
  sh: "Shell", bash: "Shell", zsh: "Shell", ksh: "Shell", fish: "fish",
  ps1: "PowerShell", psm1: "PowerShell", psd1: "PowerShell", bat: "Batchfile", cmd: "Batchfile",
  sql: "SQL", html: "HTML", htm: "HTML", xhtml: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", styl: "Stylus",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  tex: "TeX", bib: "BibTeX", proto: "Protocol Buffer", graphql: "GraphQL", gql: "GraphQL",
  tf: "HCL", tfvars: "HCL", hcl: "HCL", nix: "Nix",
  ipynb: "Jupyter Notebook", vim: "Vim Script", asm: "Assembly", s: "Assembly",
  wat: "WebAssembly", wast: "WebAssembly", glsl: "GLSL", wgsl: "WGSL",
  prisma: "Prisma", rego: "Open Policy Agent", cu: "Cuda", metal: "Metal",
  gleam: "Gleam", rkt: "Racket", scm: "Scheme", lisp: "Common Lisp", el: "Emacs Lisp",
  prolog: "Prolog", raku: "Raku", cr: "Crystal", d: "D", vala: "Vala", elm: "Elm",
  purs: "PureScript", res: "ReScript", re: "Reason", lean: "Lean 4", idr: "Idris", agda: "Agda",
  f90: "Fortran Free Form", f95: "Fortran Free Form", f03: "Fortran Free Form", f08: "Fortran Free Form",
  pas: "Pascal", adb: "Ada", ads: "Ada", cob: "COBOL", matlab: "MATLAB", wl: "Wolfram Language",
  do: "Stata", sas: "SAS", tcl: "Tcl", gd: "GDScript", vb: "Visual Basic .NET",
}));

// Build products and vendored trees usually hold more files than the sources,
// so they must not decide the project's language.
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "vendor", "third_party", "third-party", "dist", "build", "out",
  "target", "coverage", ".next", ".nuxt", "__pycache__",
]);

const GENERATED = /(?:\.d\.[cm]?ts|\.(?:min|bundle|generated)\.[^./]+)$/i;

export function detectLanguage(files) {
  if (typeof files !== "string" || !files) return null;
  const counts = new Map();
  let headers = 0;
  for (const path of files.split("\0")) {
    if (!path) continue;
    const parts = path.split("/");
    if (parts.slice(0, -1).some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) continue;
    const name = parts[parts.length - 1].toLowerCase();
    if (GENERATED.test(name)) continue;
    const dot = name.lastIndexOf(".");
    if (dot < 1) continue;
    const extension = name.slice(dot + 1);
    if (extension === "h") { headers++; continue; }
    const language = BY_EXTENSION.get(extension);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  if (headers) {
    const language = (counts.get("C++") ?? 0) > (counts.get("C") ?? 0) ? "C++" : "C";
    counts.set(language, (counts.get(language) ?? 0) + headers);
  }
  let best = null;
  for (const [language, count] of counts) {
    if (!best || count > best.count || (count === best.count && language < best.language)) {
      best = { language, count };
    }
  }
  return best?.language ?? null;
}

// A file the agent names explicitly (an edit's file_path, a patch's path) is a
// stronger signal than the repository's dominant language, and documents count
// here: writing a .md file is Markdown even when README.md never decides a
// repository's language.
const EXPLICIT_BY_EXTENSION = new Map(Object.entries({
  md: "Markdown", mdx: "Markdown",
  json: "JSON", jsonc: "JSON", json5: "JSON",
  yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  csv: "CSV", tsv: "TSV", txt: "Text", xml: "XML",
}));

const EXPLICIT_BY_NAME = new Map(Object.entries({
  dockerfile: "Docker", makefile: "Makefile", "cmakelists.txt": "CMake",
}));

export function languageForFile(value) {
  if (typeof value !== "string" || !value) return null;
  const path = value.split(/[?#]/)[0].replace(/\\/g, "/");
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = EXPLICIT_BY_NAME.get(name);
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot < 1) return null;
  const extension = name.slice(dot + 1);
  return BY_EXTENSION.get(extension) ?? EXPLICIT_BY_EXTENSION.get(extension) ?? null;
}
