export const languageByExtension = {
  py: 'python', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hxx: 'cpp',
  go: 'go', rs: 'rust', sql: 'sqlite',
};

export const monacoLanguageByExtension = {
  ...languageByExtension,
  c: 'cpp', h: 'cpp',
  json: 'json', html: 'html', htm: 'html', css: 'css', md: 'markdown', markdown: 'markdown',
  txt: 'plaintext', sql: 'sql', xml: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell',
};

export const languageBadgeByExtension = {
  py: 'Py', js: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX', java: 'Java', c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', cxx: 'C++', 'c++': 'C++', hpp: 'C++', hxx: 'C++', go: 'Go', rs: 'Rs', sql: 'SQL',
};

export function extensionOf(name = '') {
  return (name.split(/[\\/]/).pop()?.split('.').pop() || '').toLowerCase();
}

export function getEditorLanguage(name = '') {
  return monacoLanguageByExtension[extensionOf(name)] || 'plaintext';
}

export function getServiceLanguage(name = '') {
  return languageByExtension[extensionOf(name)] || null;
}
