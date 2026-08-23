export function isAdminPath(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}
