import test from 'node:test';
import assert from 'node:assert/strict';
import { getEditorLanguage, getServiceLanguage, languageByExtension } from '../src/languages.js';

test('every backend language maps to an editor grammar', () => {
  for (const [extension, language] of Object.entries(languageByExtension)) {
    assert.equal(getServiceLanguage(`sample.${extension}`), language, `${extension} service mapping`);
    assert.notEqual(getEditorLanguage(`sample.${extension}`), 'plaintext', `${extension} editor grammar`);
  }
});

test('extension mapping handles folders, case, and common aliases', () => {
  assert.equal(getEditorLanguage('project/src/MAIN.PY'), 'python');
  assert.equal(getEditorLanguage('src/solver.C++'), 'cpp');
  assert.equal(getEditorLanguage('src/native.c'), 'cpp');
  assert.equal(getEditorLanguage('src/header.hpp'), 'cpp');
  assert.equal(getEditorLanguage('notes.json'), 'json');
  assert.equal(getEditorLanguage('page.html'), 'html');
  assert.equal(getEditorLanguage('queries/report.SQL'), 'sql');
  assert.equal(getServiceLanguage('queries/report.SQL'), 'sqlite');
  assert.equal(getServiceLanguage('notes.json'), null);
  assert.equal(getEditorLanguage('unknown.file'), 'plaintext');
});
