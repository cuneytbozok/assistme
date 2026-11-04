#!/usr/bin/env node
import { main } from '../native-host/main.js';

main(process.argv).then(
  (code) => {
    if (code !== 'running') process.exit(code);
  },
  () => process.exit(1),
);
