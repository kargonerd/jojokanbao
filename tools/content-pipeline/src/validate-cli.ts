#!/usr/bin/env node
import { validatePipelineOutput } from "./validate-output";

const root = process.argv[2];
if (!root) throw new Error("Usage: validate <pipeline-output-directory>");
const result = await validatePipelineOutput(root);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errors.length) process.exitCode = 1;
