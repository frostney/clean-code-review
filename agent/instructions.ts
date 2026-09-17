import { defineInstructions } from 'eve/instructions';

import { buildInstructions } from './lib/prompt';

export default defineInstructions({
  content: buildInstructions(),
});
