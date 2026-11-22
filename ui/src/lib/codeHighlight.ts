import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  cpp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  r,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

export type HighlightLanguage = keyof typeof LANGUAGES;

export const MAX_HIGHLIGHT_CHARS = 256 * 1024;

export function highlightCode(code: string, language: string): string | null {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  if (!hljs.getLanguage(language)) {
    if (!Object.hasOwn(LANGUAGES, language)) {
      for (const name of Object.keys(LANGUAGES)) register(name as HighlightLanguage);
      if (!hljs.getLanguage(language)) return null;
    } else register(language as HighlightLanguage);
  }
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

function register(language: HighlightLanguage) {
  if (!hljs.getLanguage(language)) hljs.registerLanguage(language, LANGUAGES[language]);
}
