import { defineAgent } from 'eve';

export default defineAgent({
  defaultTools: false,
  // Only a chat with the agent reaches the model; the MCP tools never do.
  model: 'openai/gpt-5.6-luna-fast',
});
