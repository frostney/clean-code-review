import { ForbiddenError, httpBasic } from 'eve/channels/auth';
import { z } from 'zod';

// A published app imports these from 'eve-channel-mcp'.
import {
  defineMcpTool,
  McpToolOperationError,
  mcpServerChannel,
} from '../../../src/index.js';

const ABSOLUTE_ZERO_C = -273.15;
const FAHRENHEIT_PER_CELSIUS = 1.8;
const FAHRENHEIT_AT_ZERO_C = 32;

const convertTemperature = defineMcpTool({
  async call({ celsius }) {
    const result = {
      fahrenheit: celsius * FAHRENHEIT_PER_CELSIUS + FAHRENHEIT_AT_ZERO_C,
      kelvin: celsius - ABSOLUTE_ZERO_C,
    };

    return {
      content: [{ text: JSON.stringify(result), type: 'text' }],
      structuredContent: result,
    };
  },
  definition: {
    annotations: { idempotentHint: true, readOnlyHint: true },
    description: 'Convert a temperature in degrees Celsius.',
    inputSchema: z.object({
      celsius: z.number().min(ABSOLUTE_ZERO_C).describe('Degrees Celsius.'),
    }),
    name: 'convert_temperature',
    outputSchema: z.object({ fahrenheit: z.number(), kelvin: z.number() }),
  },
});

const divide = defineMcpTool({
  async call({ dividend, divisor }) {
    if (divisor === 0) {
      throw new McpToolOperationError(
        'invalid_input',
        'Cannot divide by zero.',
      );
    }

    return { content: [{ text: String(dividend / divisor), type: 'text' }] };
  },
  definition: {
    description: 'Divide one number by another.',
    inputSchema: z.object({ dividend: z.number(), divisor: z.number() }),
    name: 'divide',
  },
});

const whoami = defineMcpTool({
  async call(_input, { auth }, { requestIp }) {
    const principal = {
      authenticator: auth.authenticator,
      principalId: auth.principalId,
      principalType: auth.principalType,
      requestIp,
    };

    return {
      content: [{ text: JSON.stringify(principal), type: 'text' }],
      structuredContent: principal,
    };
  },
  definition: {
    annotations: { readOnlyHint: true },
    description: 'Report the principal this call was authenticated as.',
    inputSchema: z.object({}),
    name: 'whoami',
    outputSchema: z.object({
      authenticator: z.string(),
      principalId: z.string(),
      principalType: z.string(),
      requestIp: z.string().nullable(),
    }),
  },
});

// A known password is acceptable only under `eve dev`, on loopback.
const password =
  process.env.EXAMPLE_MCP_PASSWORD ??
  (process.env.EVE_DEV === '1' ? 'example-only' : undefined);

export default mcpServerChannel({
  auth:
    password === undefined
      ? () => {
          throw new ForbiddenError({ message: 'Set EXAMPLE_MCP_PASSWORD.' });
        }
      : httpBasic({ password, username: 'example' }),
  instructions: 'Example tools: convert a temperature, divide, and whoami.',
  name: 'eve-channel-mcp-example',
  route: '/mcp',
  tools: [convertTemperature, divide, whoami],
  version: '0.1.0',
});
