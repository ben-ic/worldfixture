#!/usr/bin/env node
import { main } from "../src/cli.mjs";

await main(process.argv.slice(2));
