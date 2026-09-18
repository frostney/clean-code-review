import { defineInstructions } from 'eve/instructions';

import { buildInstructions } from './lib/review/prompt';

export default defineInstructions({
  content: buildInstructions(),
});
