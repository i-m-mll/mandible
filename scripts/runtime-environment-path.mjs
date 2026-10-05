#!/usr/bin/env bun
import path from 'node:path';
import { runtimeEnvironment } from './runtime-environment.mjs';

const [runtime, root] = process.argv.slice(2);
if (!path.isAbsolute(runtime || '') || !path.isAbsolute(root || '')) throw new Error('Exact runtime and checkout paths are required.');
process.stdout.write(runtimeEnvironment({ runtime, root }).PATH);
