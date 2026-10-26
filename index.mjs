#!/usr/bin/env node
// Unisites deploy: one step in a repository's GitHub Actions workflow, or one
// command on a computer or in Cloudflare Workers Builds.
//
// 1. Asks Unisites which of its sites follow this repository's branch, and how
//    each is built (set on app.unisites.ge; worked out here when not set).
// 2. Builds each one, printing every line here and sending it to Unisites,
//    where the site's page shows it as it comes.
// 3. Zips the built folder and uploads it: Unisites makes it a version.
//
// On GitHub Actions there is no key: every call carries GitHub's OIDC token for
// this run, which says which repository and commit this is. Unisites takes
// uploads only for the sites of this repository. The workflow needs
// `permissions: id-token: write`.
//
// Anywhere else, the site's deploy key (made on app.unisites.ge, the site's
// Settings) is in UNISITES_KEY, and the branch and commit come from git, or
// from Cloudflare Workers Builds' own variables. The commit must be on GitHub
// already, and a computer's working tree clean, so a version always names
// the commit it was built from:
//
//   UNISITES_KEY=usk_… npx -y github:unikeygeorgia/unisites-deploy
//
// Node's own modules only, so there is nothing to install.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP_OUTPUT = ".cloudflare/output/v0/workers/default";
const UNISITES = (process.env.INPUT_URL || process.env.UNISITES_URL || "https://app.unisites.ge").replace(
  /\/+$/,
  "",
);
const KEY = process.env.UNISITES_KEY || "";
const ON_GITHUB = process.env.GITHUB_ACTIONS === "true";
const ON_CLOUDFLARE = Boolean(process.env.WORKERS_CI);

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const workspace = process.env.GITHUB_WORKSPACE || git("rev-parse", "--show-toplevel") || process.cwd();

/** With a deploy key: the branch and commit this build is of, as Unisites is told. */
const at = KEY
  ? {
      branch: process.env.WORKERS_CI_BRANCH || git("rev-parse", "--abbrev-ref", "HEAD"),
      commit: process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse", "HEAD"),
    }
  : null;

function fail(message) {
  console.log(ON_GITHUB ? `::error::${message}` : `✗ ${message}`);
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
  const headers = at
    ? {
        authorization: `Bearer ${KEY}`,
        "content-type": contentType,
        "x-unisites-branch": at.branch,
        "x-unisites-builder": ON_CLOUDFLARE ? "cloudflare" : "computer",
        "x-unisites-commit": at.commit,
      }
    : { authorization: `Bearer ${await runToken()}`, "content-type": contentType };
  const response = await fetch(`${UNISITES}/api/github/builds/${path}`, {
    body,
    headers,
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

  // An app's build is a Worker: Cloudflare's Build Output, as vinext and the
  // Cloudflare Vite plugin write it. A site's is a folder of pages.
  const app = job.kind === "app";
  const where = job.output || (app ? APP_OUTPUT : "dist");
  const output = resolve(dir, where);
  if (!existsSync(output) || !statSync(output).isDirectory()) {
    return failed(
      app
        ? `the app's Worker build is not at ${where}/: build it with vinext (Cloudflare's Vite plugin)`
        : `the built site is not at ${where}/`,
    );
  }
  if (app && !existsSync(join(output, "worker.config.json"))) {
    return failed(`${where}/worker.config.json is missing: this is not a Worker build`);
  }
  const zip = join(tmpdir(), `unisites-${job.slug}.zip`);
  if ((await run(`rm -f "${zip}" && zip -r -q -X "${zip}" .`, output, log, true)) !== 0) {
    return failed("the built site could not be zipped");
  }
  // An app's schema travels with its build: Unisites applies what is new on deploy.
  if (app && existsSync(join(dir, "migrations"))) {
    log.line("+ migrations/");
    if ((await run(`zip -r -q -X "${zip}" migrations -i 'migrations/*.sql'`, dir, log, true)) !== 0) {
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

/** A computer's build must be of a commit as it is: nothing changed, nothing unpushed. */
function readyHere() {
  if (!at || ON_CLOUDFLARE) return true;
  if (!at.commit || !at.branch || at.branch === "HEAD") {
    fail("Run this inside the repository, on the site's branch.");
    return false;
  }
  if (git("status", "--porcelain")) {
    fail("The working tree has changes: commit them (and push) first, so the version is that commit.");
    return false;
  }
  return true;
}

try {
  if (!readyHere()) process.exit(1);
  if (at) console.log(`${at.branch} @ ${at.commit.slice(0, 7)} → ${UNISITES}`);
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
