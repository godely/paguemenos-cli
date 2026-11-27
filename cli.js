#!/usr/bin/env node
import { retailer } from './index.js';
import { run } from './runner.js';
run(retailer, process.argv.slice(2), 'paguemenos').catch(err => { console.error(err.message); process.exitCode = 2; });
