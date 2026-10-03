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
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
      pending += `${text}\n`;
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

  const output = resolve(dir, job.output || "dist");
  if (!existsSync(output) || !statSync(output).isDirectory()) {
    return failed(`the built site is not at ${job.output || "dist"}/`);
  }
  const zip = join(tmpdir(), `unisites-${job.slug}.zip`);
  if ((await run(`rm -f "${zip}" && zip -r -q -X "${zip}" .`, output, log, true)) !== 0) {
    return failed("the built site could not be zipped");
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
