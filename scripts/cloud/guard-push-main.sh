#!/bin/sh
# Fail-closed allowlist: a cloud session may run only
# `git push [-u|--set-upstream] [--force-with-lease[=<ref>:<sha>]] <remote> <non-main branch>`.
# Bare pushes, --all, --mirror, --tags, refspecs containing `:`, `+` or `refs/`, and every prefix,
# operator, redirection, Git global option or extra command are refused.
# This is a bypassable policy control: string builders and wrappers (`sh -c`, `bash -lc`, `eval`,
# aliases, functions, `xargs`, `script`, and similar forms) cannot be seen and remain out of scope.
# GitHub operations such as `gh pr merge` are outside this git-push-only guard.
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

node -e '
  const apostrophe = String.fromCharCode(39);
  const REFUSE_SHAPE = `refused: a cloud session pushes only ${apostrophe}git push [-u] [--force-with-lease] <remote> <branch>${apostrophe} to a non-main branch (docs/design/cloud-seat.md §6)`;
  const REFUSE_UNRESOLVED = "refused: cannot resolve the push destination without evaluating the command";
  const singleQuote = String.fromCharCode(39);
  const syntax = new Set([";", "&", "|", "(", ")", "{", "}", "<", ">", "!"]);

  function refuse(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }

  function tokenize(command) {
    const tokens = [];
    let token = "";
    let tokenStarted = false;
    let quote = "";
    let error = false;
    let hasNewline = false;

    const finishToken = () => {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    };

    for (let i = 0; i < command.length; i += 1) {
      const ch = command[i];
      if (quote === "single") {
        if (ch === singleQuote) quote = "";
        else {
          if (ch === "\n") hasNewline = true;
          token += ch;
        }
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
            if (next === "\n") hasNewline = true;
            else token += next;
            tokenStarted = true;
            i += 1;
            continue;
          }
        }
        if (ch === "\n") hasNewline = true;
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
        if (next === "\n") {
          hasNewline = true;
        } else {
          token += next;
          tokenStarted = true;
        }
        i += 1;
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        finishToken();
      } else if (ch === "\n") {
        finishToken();
        tokens.push(ch);
        hasNewline = true;
      } else if (syntax.has(ch)) {
        finishToken();
        tokens.push(ch);
      } else {
        token += ch;
        tokenStarted = true;
      }
    }

    if (quote !== "") error = true;
    finishToken();
    return { tokens, error, hasNewline };
  }

  function isPushCandidate(tokens) {
    return tokens.some((token, index) => token === "push"
      && tokens.slice(0, index).some(prefix => prefix === "git" || prefix.endsWith("/git")));
  }

  function allowed(tokens, hasNewline) {
    if (hasNewline || tokens[0] !== "git" || tokens[1] !== "push") return false;

    let index = 2;
    let upstream = false;
    let forceWithLease = false;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === "-u" || token === "--set-upstream") {
        if (upstream) return false;
        upstream = true;
        index += 1;
        continue;
      }
      if (token === "--force-with-lease" || /^--force-with-lease=[^:\s]+:[^:\s]+$/.test(token)) {
        if (forceWithLease) return false;
        forceWithLease = true;
        index += 1;
        continue;
      }
      break;
    }

    if (tokens.length - index !== 2) return false;
    const remote = tokens[index];
    const branch = tokens[index + 1];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
    if (branch.includes(":") || branch.startsWith("+") || branch.startsWith("refs/")) return false;
    if (branch === "main" || branch === "heads/main" || branch === "refs/heads/main") return false;
    return !branch.endsWith("/main");
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

    const parsed = tokenize(command);
    if (!isPushCandidate(parsed.tokens)) return;
    if (parsed.error) refuse(REFUSE_UNRESOLVED);
    if (!allowed(parsed.tokens, parsed.hasNewline)) refuse(REFUSE_SHAPE);
  });
'
