/**
 * Luna's own calls run inside the judge model, so their usage reaches eve's
 * OpenTelemetry trace only through the AI SDK's global integration. The spans
 * must report the tokens `ReviewUsage` counts, and carry no cost: cost stays
 * the Gateway's `providerMetadata.gateway.cost`, as eve's budget reads it.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { registerTelemetry } from 'ai';
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';

// The integration eve registers in production, so the test cannot drift from it.
// biome-ignore lint/style/noRestrictedImports: eve ships its vendored copy under dist/src, not this repo's src/.
import { OpenTelemetry } from '../../../node_modules/eve/dist/src/compiled/@ai-sdk/otel/index.js';
// biome-ignore lint/style/noRestrictedImports: eve ships its vendored copy under dist/src, not this repo's src/.
import type * as otel from '../../../node_modules/eve/dist/src/compiled/@opentelemetry/api/index.js';
import {
  emptyReviewUsage,
  LUNA_FUNCTION_ID,
  planReview,
  runReview,
} from './reviewer';
import { REVIEWER_MODEL } from './summary';

interface RecordedSpan {
  attributes: Record<string, otel.AttributeValue>;
  name: string;
}

function recordingTracer(spans: RecordedSpan[]): otel.Tracer {
  return {
    startSpan(name, options) {
      const attributes: Record<string, otel.AttributeValue> = {};
      const set = (values: otel.Attributes) => {
        for (const [key, value] of Object.entries(values)) {
          if (value !== undefined) {
            attributes[key] = value;
          }
        }
      };

      set(options?.attributes ?? {});
      // The vendored Span type omits setAttributes, which the integration calls.
      const span: otel.Span & {
        setAttributes(values: otel.Attributes): otel.Span;
      } = {
        addEvent: () => span,
        end: () => {
          spans.push({ attributes, name });
        },
        recordException: () => {},
        setAttribute(key, value) {
          set({ [key]: value });

          return span;
        },
        setAttributes(values) {
          set(values);

          return span;
        },
        setStatus: () => span,
        spanContext: () => ({
          spanId: String(spans.length + 1).padStart(16, '0'),
          traceFlags: 1,
          traceId: '1'.padStart(32, '0'),
        }),
      };

      return span;
    },
  };
}

const telemetryGlobal = globalThis as {
  AI_SDK_DEFAULT_PROVIDER?: unknown;
  AI_SDK_TELEMETRY_INTEGRATIONS?: unknown;
};

afterEach(() => {
  telemetryGlobal.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  telemetryGlobal.AI_SDK_DEFAULT_PROVIDER = undefined;
});

test('Luna spans report the tokens ReviewUsage counts and no cost', async () => {
  const spans: RecordedSpan[] = [];

  registerTelemetry(new OpenTelemetry({ tracer: recordingTracer(spans) }));
  telemetryGlobal.AI_SDK_DEFAULT_PROVIDER = new MockProviderV4({
    languageModels: {
      [REVIEWER_MODEL]: new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ id: 'part', type: 'text-start' });
              controller.enqueue({
                delta: '## Overall\nFine.\n',
                id: 'part',
                type: 'text-delta',
              });
              controller.enqueue({ id: 'part', type: 'text-end' });
              controller.enqueue({
                finishReason: { raw: 'stop', unified: 'stop' },
                providerMetadata: { gateway: { cost: '0.0042' } },
                type: 'finish',
                usage: {
                  inputTokens: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    noCache: 1200,
                    total: 1200,
                  },
                  outputTokens: { reasoning: 0, text: 80, total: 80 },
                },
              });
              controller.close();
            },
          }),
        }),
      }),
    },
  });

  const plan = await planReview({
    files: [{ content: 'export const total = 1 + 2;\n', path: 'src/total.ts' }],
    judgments: {},
  });
  const { usage } = await runReview(
    plan,
    () => {
      /* The page's sink; the text is not what this test asserts. */
    },
    undefined,
    emptyReviewUsage(),
  );
  // The call's root span names its function; it carries the call's total usage.
  const calls = spans.filter(
    (s) =>
      s.name.startsWith('invoke_agent ') &&
      s.attributes['gen_ai.agent.name'] === LUNA_FUNCTION_ID,
  );
  const total = (key: string) =>
    calls.reduce((sum, s) => sum + Number(s.attributes[key] ?? 0), 0);

  assert.equal(calls.length, plan.parts.length);
  assert.equal(usage.inputTokens, 1200 * plan.parts.length);
  assert.equal(total('gen_ai.usage.input_tokens'), usage.inputTokens);
  assert.equal(total('gen_ai.usage.output_tokens'), usage.outputTokens);
  assert.ok(Math.abs(usage.costUsd - 0.0042 * plan.parts.length) < 1e-12);
  assert.deepEqual(
    spans
      .flatMap((s) => Object.keys(s.attributes))
      .filter((k) => /cost/i.test(k)),
    [],
  );
});
