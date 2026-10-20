// Unisites deploy: one step in a repository's GitHub Actions workflow.
//
// 1. Asks Unisites which of its sites follow this repository's branch, and how
//    each is built (set on app.unisites.ge; worked out here when not set).
// 2. Builds each one, printing every line here and sending it to Unisites,
//    where the site's page shows it as it comes.
// 3. Zips the built folder and uploads it: Unisites makes it a version.
//
// There is no key: every call carries GitHub's OIDC token for this run, which
// says which repository and commit this is. Unisites takes uploads only for
// the sites of this repository. The workflow needs `permissions: id-token: write`.
// Node's own modules only, so there is nothing to install.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// An app's build, in the order it is looked for (ADR 0027 on Unisites):
// Cloudflare's Build Output, as vinext writes it;
const APP_OUTPUT = ".cloudflare/output/v0/workers/default";
// the Cloudflare Vite plugin's note of the Wrangler build it wrote (Astro,
// React Router, any Vite project), which `wrangler deploy` follows too;
const VITE_DEPLOY = ".wrangler/deploy/config.json";
// the project's own Wrangler config, bundled by `wrangler deploy --dry-run`.
const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json"];
const UNISITES = (process.env.INPUT_URL || "https://app.unisites.ge").replace(/\/+$/, "");
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

function fail(message) {
  console.log(`::error::${message}`);
  process.exitCode = 1;
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** GitHub's word for this run, made for Unisites. A fresh one per call: they live minutes. */
async function runToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Error("GitHub gave this job no OIDC token: add `permissions: id-token: write` to the workflow.");
  }
  const response = await fetch(`${url}&audience=${encodeURIComponent(UNISITES)}`, {
    headers: { authorization: `bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub's OIDC token: ${response.status}`);
  return (await response.json()).value;
}

async function call(path, body, contentType = "application/json") {
  const response = await fetch(`${UNISITES}/api/github/builds/${path}`, {
    body,
    headers: { authorization: `Bearer ${await runToken()}`, "content-type": contentType },
    method: "POST",
  });
  const answer = await response.json().catch(() => ({}));
  return { answer, ok: response.ok, status: response.status };
}

// Terminal colours: the log here keeps them, the page on Unisites has no use for them.
const COLOURS = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Sends a build's lines to Unisites in order, a batch every two seconds. */
function logSender(slug) {
  let pending = "";
  let chain = Promise.resolve();
  const flush = () => {
    if (!pending) return chain;
    const text = pending;
    pending = "";
    chain = chain.then(() => call("log", JSON.stringify({ slug, text })).catch(() => {}));
    return chain;
  };
  const timer = setInterval(flush, 2000);
  return {
    line(text) {
      pending += `${text.replace(COLOURS, "")}\n`;
      if (pending.length > 16 * 1024) void flush();
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}

/** Runs a command in bash, every line here and to the log; resolves with its exit code. */
function run(command, cwd, log, quiet = false) {
  if (!quiet) {
    log.line(`$ ${command}`);
    console.log(`$ ${command}`);
  }
  return new Promise((done) => {
    const child = spawn("bash", ["-eo", "pipefail", "-c", command], {
      cwd,
      env: { ...process.env, CI: "true" },
    });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const text of lines) {
          console.log(text);
          log.line(text);
        }
      });
      stream.on("end", () => {
        if (rest) {
          console.log(rest);
          log.line(rest);
        }
      });
    }
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(127));
  });
}

/** How the project installs its packages, from its lock file. */
function installOf(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "corepack enable && pnpm install --frozen-lockfile";
  if (existsSync(join(dir, "yarn.lock"))) return "corepack enable && yarn install";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    return "npm install -g bun && bun install --frozen-lockfile";
  }
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci";
  return "npm install";
}

function buildOf(dir) {
  const pkg = existsSync(join(dir, "package.json"))
    ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    : {};
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm run build";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn build";
  return pkg.scripts?.build ? "npm run build" : "";
}

/** A JSON file that may have comments and trailing commas, as wrangler.jsonc does. */
function parseJsonc(text) {
  let out = "";
  // Where a comma was written that only whitespace and comments have followed.
  let comma = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      comma = -1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if ((c === "}" || c === "]") && comma >= 0) {
      out = out.slice(0, comma) + out.slice(comma + 1) + c;
      comma = -1;
    } else {
      if (c === ",") comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out += c;
    }
  }
  return JSON.parse(out);
}

const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The folder both are in. */
function commonFolder(a, b) {
  let common = a;
  while (!inside(common, b)) common = dirname(common);
  return common;
}

/** Whether git keeps the file: then it is the repository's, not this build's. */
function tracked(dir, path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", relative(dir, path)], {
    cwd: dir,
    stdio: "ignore",
  });
  return result.status === 0;
}

/** Copies a build's folders into one, as they lie next to each other. */
function stage(slug, root, folders) {
  const at = join(tmpdir(), `unisites-${slug}-build`);
  rmSync(at, { force: true, recursive: true });
  mkdirSync(at, { recursive: true });
  for (const folder of new Set(folders)) {
    cpSync(folder, join(at, relative(root, folder)), { recursive: true });
  }
  return at;
}

/** The migrations folder of a Wrangler config's first database, else migrations/ beside package.json. */
function migrationsOf(dir, config, configDir) {
  const own = config?.d1_databases?.find((d) => typeof d?.migrations_dir === "string");
  const found = own ? resolve(configDir, own.migrations_dir) : join(dir, "migrations");
  return existsSync(found) && statSync(found).isDirectory() ? found : null;
}

/**
 * An app's build, found: the folder to zip, and where its database's
 * migrations are. A Wrangler build goes up as its config's folder and its
 * assets' folder, side by side as the build left them; Unisites reads the
 * rest from its wrangler.json.
 */
async function appBuild(job, dir, log) {
  if (job.output) {
    const output = resolve(dir, job.output);
    if (!existsSync(output) || !statSync(output).isDirectory()) {
      return { problem: `the app's build is not at ${job.output}/` };
    }
    return { folder: output, migrations: migrationsOf(dir, null, dir) };
  }

  const buildOutput = join(dir, APP_OUTPUT);
  if (existsSync(join(buildOutput, "worker.config.json"))) {
    log.line(`+ ${APP_OUTPUT}/ (Cloudflare's Build Output)`);
    return { folder: buildOutput, migrations: migrationsOf(dir, null, dir) };
  }

  const pointer = join(dir, VITE_DEPLOY);
  if (existsSync(pointer) && !tracked(dir, pointer)) {
    const note = JSON.parse(readFileSync(pointer, "utf8"));
    if ((note.auxiliaryWorkers ?? []).length > 0) {
      return { problem: "the build has more than one Worker; Unisites runs one per app" };
    }
    const configPath = resolve(dirname(pointer), note.configPath ?? "");
    if (!existsSync(configPath)) {
      return { problem: `${VITE_DEPLOY} names ${note.configPath}, which the build did not write` };
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const configDir = dirname(configPath);
    const assets =
      typeof config.assets?.directory === "string"
        ? resolve(configDir, config.assets.directory)
        : null;
    const root = assets ? commonFolder(configDir, assets) : configDir;
    if (!inside(dir, root)) {
      return { problem: `${relative(dir, configPath)}: its assets are outside the project` };
    }
    log.line(`+ ${relative(dir, configPath)} (the Cloudflare Vite plugin's build)`);
    const folders = [configDir, ...(assets && existsSync(assets) ? [assets] : [])];
    return {
      folder: stage(job.slug, root, folders),
      migrations: migrationsOf(dir, config, configDir),
    };
  }

  const own = WRANGLER_CONFIGS.map((name) => join(dir, name)).find((path) => existsSync(path));
  if (!own) {
    return {
      problem: existsSync(join(dir, "wrangler.toml"))
        ? "Unisites reads wrangler.jsonc or wrangler.json, not wrangler.toml: write the config as JSON (wrangler takes both)"
        : `the app's Worker build was not found: neither ${APP_OUTPUT}/ (vinext), nor ${VITE_DEPLOY} (the Cloudflare Vite plugin, as Astro's adapter uses it), nor a wrangler.jsonc with its main module`,
    };
  }
  let config;
  try {
    config = parseJsonc(readFileSync(own, "utf8"));
  } catch (error) {
    return { problem: `${basename(own)} is not JSON: ${error.message}` };
  }
  if (typeof config.main !== "string") {
    return { problem: `${basename(own)} has no main module to bundle` };
  }
  // The Worker bundled as wrangler deploy would, written beside its config, its assets beside it.
  const at = stage(job.slug, dir, []);
  const server = join(at, "server");
  const bundled = await run(
    `npx --yes wrangler deploy --dry-run --outdir "${server}"`,
    dir,
    log,
  );
  if (bundled !== 0) return { problem: `wrangler deploy --dry-run exited with ${bundled}` };
  const entry = `${basename(config.main).replace(/\.[^.]+$/, "")}.js`;
  if (!existsSync(join(server, entry))) {
    return { problem: `wrangler wrote no ${entry} for ${config.main}` };
  }
  const assets =
    typeof config.assets?.directory === "string" ? resolve(dir, config.assets.directory) : null;
  if (assets && existsSync(assets)) cpSync(assets, join(at, "client"), { recursive: true });
  writeFileSync(
    join(server, "wrangler.json"),
    JSON.stringify({
      ...config,
      ...(config.assets ? { assets: { ...config.assets, directory: "../client" } } : {}),
      main: entry,
    }),
  );
  log.line(`+ ${basename(own)} (bundled by wrangler)`);
  return { folder: at, migrations: migrationsOf(dir, config, dir) };
}

async function buildOne(job) {
  const dir = resolve(workspace, job.folder || ".");
  const log = logSender(job.slug);
  const failed = async (message) => {
    log.line(`✗ ${message}`);
    await log.close();
    await call(`finish?slug=${job.slug}&outcome=failed`, JSON.stringify({ message }));
    fail(`${job.slug}: ${message}`);
  };

  console.log(`::group::${job.slug}: building`);
  try {
    for (const command of [job.install || installOf(dir), job.build || buildOf(dir)]) {
      if (!command) continue;
      const code = await run(command, dir, log);
      if (code !== 0) return await failed(`${command} exited with ${code}`);
    }
  } finally {
    console.log("::endgroup::");
  }

  // An app's build is a Worker (appBuild); a site's is a folder of pages.
  const app = job.kind === "app";
  let output;
  let migrations = null;
  if (app) {
    const found = await appBuild(job, dir, log);
    if (found.problem) return failed(found.problem);
    ({ folder: output, migrations } = found);
  } else {
    const where = job.output || "dist";
    output = resolve(dir, where);
    if (!existsSync(output) || !statSync(output).isDirectory()) {
      return failed(`the built site is not at ${where}/`);
    }
  }
  const zip = join(tmpdir(), `unisites-${job.slug}.zip`);
  if ((await run(`rm -f "${zip}" && zip -r -q -X "${zip}" .`, output, log, true)) !== 0) {
    return failed("the built site could not be zipped");
  }
  // An app's schema travels with its build: Unisites applies what is new on deploy.
  const sql = migrations
    ? readdirSync(migrations).filter((name) => name.endsWith(".sql"))
    : [];
  if (sql.length > 0) {
    log.line(`+ migrations/ (${relative(dir, migrations) || "."}, ${sql.length})`);
    const carried = join(tmpdir(), `unisites-${job.slug}-migrations`);
    rmSync(carried, { force: true, recursive: true });
    mkdirSync(join(carried, "migrations"), { recursive: true });
    for (const name of sql) cpSync(join(migrations, name), join(carried, "migrations", name));
    if ((await run(`zip -r -q -X "${zip}" migrations`, carried, log, true)) !== 0) {
      return failed("the migrations could not be added");
    }
  }
  log.line(`→ uploading to Unisites`);
  await log.close();

  const { answer, ok, status } = await call(
    `finish?slug=${job.slug}`,
    readFileSync(zip),
    "application/zip",
  );
  if (!ok) {
    for (const problem of answer.problems ?? []) console.log(`::error::${job.slug}: ${problem}`);
    return fail(`${job.slug}: ${answer.error ?? `Unisites answered ${status}`}`);
  }
  console.log(
    `✓ ${job.slug}: version ${answer.version}${answer.shown ? `, shown at ${answer.address}` : ", saved (shown from Unisites)"}`,
  );
  summary(
    `### ✓ ${job.slug}\n\nVersion \`${answer.version}\`${answer.shown ? ` is shown at ${answer.address}` : " is saved; it is shown from Unisites"}.\n\n[Versions on Unisites](${job.address})`,
  );
}

try {
  const { answer, ok, status } = await call("start", "{}");
  if (!ok) throw new Error(answer.error ?? `Unisites answered ${status}`);
  for (const skip of answer.skipped ?? []) console.log(`– ${skip.slug}: ${skip.reason}`);
  if ((answer.builds ?? []).length === 0) {
    console.log("Nothing to build on Unisites for this commit.");
  }
  for (const job of answer.builds ?? []) await buildOne(job);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
