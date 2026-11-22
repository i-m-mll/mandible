import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';

export const remarkDirectives = unified().use(remarkParse).use(remarkDirective);
