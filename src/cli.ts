#!/usr/bin/env node
import { EXIT, main } from "./cli/main.js";

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = EXIT.usage;
  },
);
