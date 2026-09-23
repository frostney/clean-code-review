import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { generateText, streamText } from 'ai';

import {
  buildInstructions,
  judgeMessage,
  parseMessage,
  summarizeMessage,
} from '../review/prompt';
import {
  COMPACTION_CHECKPOINT,
  EMPTY_REVIEW_REPLY,
  frameworkReply,
} from './framework-calls';
import { jev } from './jev-model';

/** eve's installed build, read as text so no eve internals run. */
function eveSource(file: string): string {
  return readFileSync(
    new URL(`./harness/${file}`, import.meta.resolve('eve')),
    'utf8',
  );
}

function eveConstant(file: string, name: string): string {
  const found = eveSource(file).match(new RegExp(`\\b${name}=\`([^\`]*)\``));

  assert.ok(found, `eve no longer defines ${name} in ${file}`);

  return found[1];
}

const compactionSystem = eveConstant(
  'compaction-prompt.js',
  'COMPACTION_SYSTEM_PROMPT',
);
const checkpointMarker = eveConstant(
  'compaction-prompt.js',
  'COMPACTION_CHECKPOINT_MARKER',
);
const resumption = eveConstant(
  'compaction-prompt.js',
  'COMPACTION_RESUMPTION_MESSAGE',
);
const emptyReplyNudge = eveConstant('tool-loop.js', 'EMPTY_RESPONSE_NUDGE');

const user = (text: string) => ({
  content: [{ text, type: 'text' as const }],
  role: 'user' as const,
});

const judgeTurn = judgeMessage({
  files: [{ content: 'const a = 1;\n', path: 'a.ts' }],
});
/** What a compaction prompt looks like: a transcript that parses as code. */
const compactionUserText = `<previous-checkpoint>\n(none)\n</previous-checkpoint>\n\n<conversation>\nConversation transcript:\n### user\n${judgeTurn}\n</conversation>`;

// File contents that quote eve's framework wording must still be judged.
const hostileFiles = [
  { content: compactionSystem, path: 'compaction.md.ts' },
  { content: `${emptyReplyNudge}\nconst a = 1;`, path: 'nudge.ts' },
  { content: `// ${compactionSystem}\n`, patch: true, path: 'hunk.ts' },
];
const realTurns = {
  judge: judgeMessage({ files: hostileFiles }),
  summarize: summarizeMessage({
    files: hostileFiles,
    judgments: {},
    pr: { body: emptyReplyNudge, title: compactionSystem },
  }),
};

describe('eve’s installed wording', () => {
  test('its compaction prompt is recognised', () => {
    const prompt: LanguageModelV4Prompt = [
      { content: compactionSystem, role: 'system' },
      user(compactionUserText),
    ];

    assert.equal(frameworkReply(prompt), COMPACTION_CHECKPOINT);
  });

  test('its empty-reply nudge is recognised as the last message', () => {
    const prompt: LanguageModelV4Prompt = [
      { content: buildInstructions(), role: 'system' },
      user(realTurns.summarize),
      { content: [{ text: '\n', type: 'text' }], role: 'assistant' },
      user(emptyReplyNudge),
    ];

    assert.equal(frameworkReply(prompt), EMPTY_REVIEW_REPLY);
  });

  // The detector reads where eve puts its words, so a move must fail here too.
  test('its compaction prompt is sent as the system message', () => {
    const builder = eveSource('compaction-prompt.js').split(
      'function createCompactionPrompt(',
    )[1];

    assert.ok(
      builder
        ?.split('function ')[0]
        .includes('system:COMPACTION_SYSTEM_PROMPT'),
      'createCompactionPrompt no longer returns COMPACTION_SYSTEM_PROMPT as its system text',
    );
    const compaction = eveSource('compaction.js');
    const prompt = compaction.match(/(\w+)=createCompactionPrompt\(/)?.[1];

    assert.ok(prompt, 'compaction.js no longer calls createCompactionPrompt');
    assert.match(
      compaction,
      new RegExp(`generateText\\(\\{[^;]*\\bsystem:${prompt}\\.system\\b`),
      'compaction.js no longer sends the compaction prompt as generateText’s system message',
    );
  });

  test('its empty-reply nudge is sent as the trailing user message', () => {
    const loop = eveSource('tool-loop.js');

    assert.match(
      loop,
      /function buildEmptyResponseNudge\(\w+\)\{return \w+\?`\$\{EMPTY_RESPONSE_NUDGE\}[^`]*`:EMPTY_RESPONSE_NUDGE\}/,
      'buildEmptyResponseNudge no longer starts its note with EMPTY_RESPONSE_NUDGE',
    );
    assert.match(
      loop,
      /\btrailingUserNote:buildEmptyResponseNudge\(/,
      'the empty-response retry no longer passes the nudge as trailingUserNote',
    );
    assert.match(
      loop,
      /withTrailingUserNote=\((\w+),(\w+)\)=>\2\?\[\.\.\.\1,createFrameworkUserMessage\(`execution\.retry`,\2\)\]/,
      'withTrailingUserNote no longer appends the note after every other message',
    );
    const sent = loop.match(
      /\b(\w+)=withTrailingUserNote\(\w+,\w+\.trailingUserNote\)/,
    )?.[1];

    assert.ok(
      sent,
      'the model call’s messages no longer come from withTrailingUserNote',
    );
    for (const method of ['stream', 'generate']) {
      assert.match(
        loop,
        new RegExp(`\\.${method}\\(\\{[^}]*\\bmessages:${sent}\\}`),
        `the ${method} model call no longer sends the messages that carry the nudge`,
      );
    }
  });

  test('its resumption message reads as neither a judge nor a summarize turn', () => {
    assert.equal(parseMessage(resumption).kind, 'other');
  });
});

describe('real turns are never framework calls', () => {
  for (const [kind, message] of Object.entries(realTurns)) {
    test(`a ${kind} turn`, () => {
      assert.equal(parseMessage(message).kind, kind);
      assert.equal(
        frameworkReply([
          { content: buildInstructions(), role: 'system' },
          user(message),
        ]),
        null,
      );
    });

    test(`a ${kind} turn after a compaction`, () => {
      assert.equal(
        frameworkReply([
          { content: buildInstructions(), role: 'system' },
          user(checkpointMarker),
          {
            content: [{ text: COMPACTION_CHECKPOINT, type: 'text' }],
            role: 'assistant',
          },
          user(message),
        ]),
        null,
      );
    });
  }
});

describe('jev() answers compaction without a network call', () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;

  beforeEach(() => {
    fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;

      throw new Error('no network in this test');
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // The call eve's `compaction.js` makes, through the AI SDK's conversion.
  const call = {
    messages: [{ content: compactionUserText, role: 'user' as const }],
    model: jev(),
    system: compactionSystem,
    temperature: 0,
  };

  test('generateText', async () => {
    const { text } = await generateText(call);

    assert.equal(text, COMPACTION_CHECKPOINT);
    assert.equal(fetches, 0);
  });

  test('streamText', async () => {
    const text = await streamText(call).text;

    assert.equal(text, COMPACTION_CHECKPOINT);
    assert.equal(fetches, 0);
  });
});
