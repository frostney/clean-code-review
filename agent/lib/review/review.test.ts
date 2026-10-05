import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cappedAt,
  clampReview,
  isProsePath,
  MAX_JUDGED_CHARS,
  skipReason,
} from './review';

function hasLoneSurrogate(text: string): boolean {
  return [...text].some((c) => {
    const code = c.codePointAt(0) ?? 0;

    return code >= 0xd800 && code <= 0xdfff;
  });
}

test('cappedAt leaves the text alone when it fits', () => {
  assert.equal(cappedAt('abc', 3), 'abc');
  assert.equal(cappedAt('a🙂', 3), 'a🙂');
});

test('cappedAt drops a character rather than halving it', () => {
  assert.equal(cappedAt('a🙂b', 2), 'a');
  assert.equal(cappedAt('ab🙂', 3), 'ab');
});

test('the clamp every judge message goes through cuts whole characters', () => {
  // `prompt.ts` routes each judge turn through this, so it, not the judging
  // itself, is the cut that fires in the product.
  const head = 'x'.repeat(MAX_JUDGED_CHARS - 1);
  const clamped = clampReview(
    { files: [{ content: `${head}🙂${'y'.repeat(5000)}`, path: 'a.ts' }] },
    MAX_JUDGED_CHARS,
  ).files[0].content;

  assert.equal(clamped.length, MAX_JUDGED_CHARS - 1);
  assert.ok(!hasLoneSurrogate(clamped));
});

test('data, config, markup and query files are skipped as not code', () => {
  for (const path of [
    'extension/locales/de.json',
    'tsconfig.json',
    'playbooks/configure.yaml',
    '.github/workflows/check.yml',
    'anchor/client/Cargo.toml',
    'res/xml/method.xml',
    'TerminalApp/Resources/en-US/Resources.resw',
    'TerminalApp/TerminalPage.xaml',
    'templates/zeroclaw-env.conf.j2',
    'references/report-template.html',
    'styles/app.scss',
    'scripts/startup_metrics.sql',
    'server/Dockerfile',
    'docker/Dockerfile.dev',
    'docker/Dockerfile-alpine',
    'docker/Dockerfile_alpine',
    'Dockerfile.dev.arm64',
    '.stylelintrc',
    'phpunit.xml.dist',
    'events.jsonl',
    'views/page.hbs',
    '.gitignore',
    '.eslintrc',
    'go.mod',
    '.github/CODEOWNERS',
  ]) {
    assert.equal(skipReason({ content: '{}', path }), 'not_code', path);
  }
});

test('source files, build scripts and components are still judged', () => {
  for (const path of [
    'src/a.ts',
    'web/Card.tsx',
    'ui/PullDetail.svelte',
    'app/Page.vue',
    'lib/tool.py',
    'Gemfile',
    'Makefile',
    'scripts/run.sh',
    'build.gradle.kts',
    'src/config/json.ts',
    'src/changelog/parser.ts',
    'src/parsers/dockerfile.ts',
    'Dockerfile.test.ts',
    'Models/Dockerfile.cs',
    'src/Dockerfile.java',
    'pkg/dockerfile.go',
    'bin/changelog',
    'scripts/authors',
    '.eslintrc.js',
  ]) {
    assert.equal(skipReason({ content: 'x', path }), null, path);
    assert.equal(isProsePath(path), false, path);
  }
});

test('changelog fragments and LICENSE-style files are prose', () => {
  for (const path of [
    'projects/plugins/jetpack/changelog/fix-paypal-announce',
    'changes/1234-fix',
    'LICENSE',
    'LICENSE-MIT',
    'License',
    'COPYING.LESSER',
    'docs/NOTICE',
  ]) {
    assert.equal(isProsePath(path), true, path);
  }
});
