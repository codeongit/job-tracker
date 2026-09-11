import { resolve, relative, isAbsolute, sep } from 'node:path';

export function resolvePublicPath(publicRoot, pathname) {
  const path = resolve(publicRoot, pathname === '/' ? 'index.html' : '.' + pathname),
    relation = relative(publicRoot, path);
  if (
    !relation ||
    relation === '..' ||
    relation.startsWith('..' + sep) ||
    isAbsolute(relation) ||
    pathname.split('/').some((part) => part.startsWith('.'))
  )
    throw new Error('Not found');
  return path;
}
