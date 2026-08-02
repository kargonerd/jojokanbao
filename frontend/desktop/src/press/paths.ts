export const PRESS_ROOT = '/press';

export function pressPath(path = '') {
  if (!path || path === '/') return PRESS_ROOT;
  if (path === PRESS_ROOT || path.startsWith(`${PRESS_ROOT}/`)) return path;
  return `${PRESS_ROOT}${path.startsWith('/') ? path : `/${path}`}`;
}
