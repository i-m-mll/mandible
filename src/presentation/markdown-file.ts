const markdownSuffix = /\.(?:md|markdown|mdown|mkd|mkdn|mdx|rmd|qmd)(?:\.template)?$/i;

export function isMarkdownFile(name: string, language?: string): boolean {
  return language === "Markdown" || language === "MDX" || markdownSuffix.test(name);
}
