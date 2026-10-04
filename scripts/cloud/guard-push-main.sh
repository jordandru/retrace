#!/bin/sh
# Bypassable policy control: it prevents ordinary Claude Code Bash git pushes, not every possible GitHub write.
# It parses literal shell quoting without evaluation and fails closed when a push destination cannot be resolved.
# It examines ordinary assignments, env prefixes, git global options, and shell control operators. For
# `cd <dir> && git push`, no-refspec fallback checks still run in the hook's cwd.
# Shell string builders and wrappers (`sh -c`, `bash -lc`, `eval`, aliases, functions, `xargs`, and `script`) are out of scope.
# GitHub operations such as `gh pr merge` are outside this git-push-only guard.
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

node -e '
  const { spawnSync } = require("node:child_process");

  const REFUSE_MAIN = "refused: a cloud session never pushes main (docs/design/cloud-seat.md §6)";
  const REFUSE_UNRESOLVED = "refused: cannot resolve the push destination without evaluating the command";
  const singleQuote = String.fromCharCode(39);

  function refuse(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }

  function parseCommands(command) {
    const commands = [];
    let tokens = [];
    let token = "";
    let tokenStarted = false;
    let quote = "";
    let error = false;

    const finishToken = () => {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    };
    const finishCommand = () => {
      finishToken();
      if (tokens.length > 0) commands.push(tokens);
      tokens = [];
    };

    for (let i = 0; i < command.length; i += 1) {
      const ch = command[i];
      if (quote === "single") {
        if (ch === singleQuote) quote = "";
        else token += ch;
        tokenStarted = true;
        continue;
      }
      if (quote === "double") {
        if (ch === "\"") {
          quote = "";
          tokenStarted = true;
          continue;
        }
        if (ch === "\\") {
          const next = command[i + 1];
          if (next === undefined) {
            error = true;
            break;
          }
          if (next === "$" || next.charCodeAt(0) === 96 || next === "\"" || next === "\\" || next === "\n") {
            if (next !== "\n") token += next;
            tokenStarted = true;
            i += 1;
            continue;
          }
        }
        token += ch;
        tokenStarted = true;
        continue;
      }

      if (ch === singleQuote) {
        quote = "single";
        tokenStarted = true;
      } else if (ch === "\"") {
        quote = "double";
        tokenStarted = true;
      } else if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) {
          error = true;
          break;
        }
        if (next !== "\n") {
          token += next;
          tokenStarted = true;
        }
        i += 1;
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        finishToken();
      } else if (ch === ";" || ch === "\n" || ch === "|"
        || (ch === "&" && command[i + 1] === "&")) {
        finishCommand();
        if ((ch === "|" && command[i + 1] === "|") || ch === "&") i += 1;
      } else {
        token += ch;
        tokenStarted = true;
      }
    }

    if (quote !== "") error = true;
    finishCommand();
    return { commands, malformedLast: error && commands.length > 0 ? commands.length - 1 : -1 };
  }

  function pushInvocation(tokens) {
    let index = 0;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
    while (assignment.test(tokens[index] ?? "")) index += 1;

    if (tokens[index] === "env") {
      index += 1;
      while (tokens[index] === "-i" || assignment.test(tokens[index] ?? "")) index += 1;
    }
    if (tokens[index] !== "git") return undefined;
    index += 1;

    const gitContext = [];
    while (index < tokens.length) {
      const argument = tokens[index];
      if (argument === "push") {
        return { args: tokens.slice(index + 1), gitContext };
      }
      if (argument === "-C" || argument === "-c" || argument === "--git-dir"
        || argument === "--work-tree" || argument === "--namespace") {
        if (index + 1 >= tokens.length) return undefined;
        gitContext.push(argument, tokens[index + 1]);
        index += 2;
        continue;
      }
      if (argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=")
        || argument.startsWith("--namespace=")) {
        gitContext.push(argument);
        index += 1;
        continue;
      }
      if (argument === "--no-pager" || argument === "-p" || argument === "--exec-path"
        || argument.startsWith("--exec-path=")) {
        index += 1;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  function unresolved(token) {
    return token.includes("$") || token.charCodeAt(0) === 96 || token.includes("`")
      || token.startsWith("~") || /[*?\[]/.test(token);
  }

  function targetsMain(refspec) {
    if (refspec.startsWith("+")) refspec = refspec.slice(1);
    const colon = refspec.indexOf(":");
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
    return destination === "main" || destination === "refs/heads/main";
  }

  function git(gitContext, args) {
    const result = spawnSync("git", [...gitContext, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : "";
  }

  function inspectPush({ args, gitContext }) {
    let remote = "";
    const refspecs = [];
    let options = true;

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (options) {
        if (argument === "--") {
          options = false;
          continue;
        }
        if (argument === "--repo") {
          if (index + 1 < args.length) remote = args[index += 1];
          continue;
        }
        if (argument.startsWith("--repo=")) {
          remote = argument.slice("--repo=".length);
          continue;
        }
        if (argument === "--receive-pack" || argument === "--exec"
          || argument === "-o" || argument === "--push-option") {
          if (index + 1 < args.length) index += 1;
          continue;
        }
        if (argument.startsWith("--receive-pack=") || argument.startsWith("--exec=")
          || argument.startsWith("--push-option=") || argument.startsWith("-")) {
          continue;
        }
      }
      if (remote === "") remote = argument;
      else refspecs.push(argument);
    }

    if ((remote !== "" && unresolved(remote)) || refspecs.some(unresolved)) refuse(REFUSE_UNRESOLVED);
    if (refspecs.some(targetsMain)) refuse(REFUSE_MAIN);
    if (refspecs.length > 0) return;

    const branch = git(gitContext, ["branch", "--show-current"]);
    if (branch === "main") refuse(REFUSE_MAIN);

    if (remote === "" && branch !== "") {
      remote = git(gitContext, ["config", "--get", `branch.${branch}.pushRemote`])
        || git(gitContext, ["config", "--get", "remote.pushDefault"])
        || git(gitContext, ["config", "--get", `branch.${branch}.remote`]);
    }

    if (remote !== "") {
      const configuredRefspecs = git(gitContext, ["config", "--get-all", `remote.${remote}.push`]);
      if (configuredRefspecs !== "") {
        if (configuredRefspecs.split("\n").some(targetsMain)) refuse(REFUSE_MAIN);
        return;
      }
    }

    const pushRef = git(gitContext, ["rev-parse", "--abbrev-ref", "@{push}"]);
    if (pushRef === "main" || (remote !== "" && pushRef === `${remote}/main`)) refuse(REFUSE_MAIN);

    const pushDefault = git(gitContext, ["config", "--get", "push.default"]) || "simple";
    if (pushDefault === "upstream" || pushDefault === "simple") {
      const mergeRef = git(gitContext, ["config", "--get", `branch.${branch}.merge`]);
      if (mergeRef === "refs/heads/main") refuse(REFUSE_MAIN);
    }
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    let command;
    try {
      const parsed = JSON.parse(input);
      command = typeof parsed?.tool_input?.command === "string" ? parsed.tool_input.command : "";
    } catch {
      return;
    }

    const parsed = parseCommands(command);
    parsed.commands.forEach((tokens, index) => {
      const invocation = pushInvocation(tokens);
      if (!invocation) return;
      if (index === parsed.malformedLast) refuse(REFUSE_UNRESOLVED);
      inspectPush(invocation);
    });
  });
'
